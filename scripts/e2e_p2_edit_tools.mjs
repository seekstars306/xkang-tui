import fs from 'node:fs';
import path from 'node:path';
import { validatePathInRepo } from '../dist/tools/sandbox.js';
import { writeFileTool } from '../dist/tools/write.js';
import { editFileTool } from '../dist/tools/edit.js';
import { AgentHarness } from '../dist/harness/agent.js';
import { createDefaultToolRegistry } from '../dist/tools/index.js';
import { ModelGateway } from '../dist/adapters/gateway.js';

const TEST_DIR = path.resolve(process.cwd(), './test_p2_sandbox_workspace');

if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

async function runTests() {
  try {
    console.log('\n======================================================');
    console.log('🧪 开始进行「P2 阶段：文件编辑、路径沙箱与审批门」端到端测试');
    console.log('======================================================\n');

    // 1. 测试路径安全沙箱 (PathSandbox)
    console.log('▶ [1/6] 测试工作区路径沙箱越界拦截 (PathSandbox)...');
    const valid = validatePathInRepo('config/app.yml', TEST_DIR);
    console.log('   合法相对路径解析:', valid.safePath);

    let trapped = false;
    try {
      validatePathInRepo('../../system32/cmd.exe', TEST_DIR);
    } catch (err) {
      trapped = true;
      console.log('   越界拦截异常捕获:', err.message);
    }
    if (!trapped) {
      throw new Error('路径沙箱未能成功拦截越界 ../ 路径');
    }
    console.log('   ✅ 路径安全沙箱校验与拦截成功！');

    // 2. 测试 write_file 新建与覆写
    console.log('\n▶ [2/6] 测试 write_file 新建文件与覆盖文件...');
    const writeResult1 = await writeFileTool.execute(
      {
        file_path: 'config/test.properties',
        content: 'server.port=8080\npayment.timeout=3000\napp.env=prod',
      },
      { repoPath: TEST_DIR }
    );
    console.log('   新建结果:', writeResult1);

    const targetFile = path.join(TEST_DIR, 'config/test.properties');
    if (!fs.existsSync(targetFile)) {
      throw new Error('write_file 未能成功在磁盘创建目标文件');
    }

    const approvalInfo = await writeFileTool.getApprovalInfo(
      {
        file_path: 'config/test.properties',
        content: 'server.port=9090\npayment.timeout=5000\napp.env=prod',
      },
      { repoPath: TEST_DIR }
    );
    console.log('   write_file 审批摘要:', approvalInfo.summary);
    console.log('   write_file Diff 预览:\n' + approvalInfo.diffPreview);
    console.log('   ✅ write_file 执行与审批信息提取成功！');

    // 3. 测试 edit_file 精准单处替换
    console.log('\n▶ [3/6] 测试 edit_file 精准代码替换...');
    const editApproval = await editFileTool.getApprovalInfo(
      {
        file_path: 'config/test.properties',
        old_string: 'payment.timeout=3000',
        new_string: 'payment.timeout=6000',
      },
      { repoPath: TEST_DIR }
    );
    console.log('   edit_file 审批 Diff 预览:\n' + editApproval.diffPreview);

    const editResult = await editFileTool.execute(
      {
        file_path: 'config/test.properties',
        old_string: 'payment.timeout=3000',
        new_string: 'payment.timeout=6000',
      },
      { repoPath: TEST_DIR }
    );
    console.log('   替换执行结果:', editResult);

    const updatedContent = fs.readFileSync(targetFile, 'utf-8');
    if (!updatedContent.includes('payment.timeout=6000') || updatedContent.includes('payment.timeout=3000')) {
      throw new Error('edit_file 替换内容不符合预期');
    }
    console.log('   ✅ edit_file 精准字符串替换成功！');

    // 4. 测试 edit_file 异常拦截 (未找到 & 歧义多处匹配)
    console.log('\n▶ [4/6] 测试 edit_file 异常防误改保护 (未匹配 / 歧义多匹配)...');
    let notFoundError = false;
    try {
      await editFileTool.execute(
        {
          file_path: 'config/test.properties',
          old_string: 'non_existent_key=999',
          new_string: 'whatever',
        },
        { repoPath: TEST_DIR }
      );
    } catch (err) {
      notFoundError = true;
      console.log('   0 处匹配报错拦截:', err.message);
    }
    if (!notFoundError) throw new Error('未能拦截 0 处匹配的修改操作');

    // 写入含有重复行的文件
    fs.writeFileSync(
      path.join(TEST_DIR, 'dup.txt'),
      'retry=3\nretry=3\nretry=3\n'
    );

    let ambiguousError = false;
    try {
      await editFileTool.execute(
        {
          file_path: 'dup.txt',
          old_string: 'retry=3',
          new_string: 'retry=5',
        },
        { repoPath: TEST_DIR }
      );
    } catch (err) {
      ambiguousError = true;
      console.log('   多处匹配未加 replace_all 歧义拦截:', err.message);
    }
    if (!ambiguousError) throw new Error('未能拦截多处匹配的歧义修改操作');

    // 显式 replace_all = true 应成功
    await editFileTool.execute(
      {
        file_path: 'dup.txt',
        old_string: 'retry=3',
        new_string: 'retry=5',
        replace_all: true,
      },
      { repoPath: TEST_DIR }
    );
    const dupContent = fs.readFileSync(path.join(TEST_DIR, 'dup.txt'), 'utf-8');
    if (dupContent !== 'retry=5\nretry=5\nretry=5\n') {
      throw new Error('replace_all 替换结果不正确');
    }
    console.log('   ✅ edit_file 异常保护与 replace_all 均通过！');

    // 5. 【核心】测试 AgentHarness 审批门机制 - 批准场景
    console.log('\n▶ [5/6] 测试 AgentHarness 审批门挂起机制 (批准场景)...');
    const registry = createDefaultToolRegistry();
    const mockGateway = {
      getCurrentModel: () => 'xkang-managed',
      switchModel: () => {},
      streamChat: async (messages, tools, onEvent) => {
        if (messages.length === 2) {
          // 第一轮回复触发 edit_file 工具调用
          const toolCall = {
            id: 'call_edit_test_01',
            name: 'edit_file',
            arguments: JSON.stringify({
              file_path: 'config/test.properties',
              old_string: 'server.port=8080',
              new_string: 'server.port=9999',
            }),
          };
          onEvent({ type: 'tool_call_start', toolCall });
          return {
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
          };
        }
        // 第二轮回复最终解答
        return {
          role: 'assistant',
          content: '【排障建议】端口已成功修复为 9999。',
        };
      },
    };

    const harness = new AgentHarness({
      gateway: mockGateway,
      registry,
      context: { repoPath: TEST_DIR },
    });

    let approvalRequestedEmitted = false;
    let approvalResolvedEmitted = false;

    const answer = await harness.run('请将配置文件端口修改为 9999', (event) => {
      if (event.type === 'approval_requested') {
        approvalRequestedEmitted = true;
        console.log('   -> 捕获到审批请求事件 (Approval Request):');
        console.log('      工具:', event.request.toolName);
        console.log('      目标文件:', event.request.filePath);
        console.log('      摘要:', event.request.summary);
        console.log('   -> 模拟员工选择【✅ 批准执行】...');
        event.resolve(true); // 批准
      } else if (event.type === 'approval_resolved') {
        approvalResolvedEmitted = true;
        console.log('   -> 捕获到审批决议已完成事件, decision =', event.approved);
      }
    });

    console.log('   Harness 最终输出:', answer);
    const postApproveContent = fs.readFileSync(targetFile, 'utf-8');
    if (!postApproveContent.includes('server.port=9999')) {
      throw new Error('批准后文件内容未实际写入磁盘！');
    }
    if (!approvalRequestedEmitted || !approvalResolvedEmitted) {
      throw new Error('审批事件未能正确派发或解决');
    }
    console.log('   ✅ 审批门批准流程流转完整且落盘成功！');

    // 6. 【核心】测试 AgentHarness 审批门机制 - 拒绝场景
    console.log('\n▶ [6/6] 测试 AgentHarness 审批门挂起机制 (拒绝场景)...');
    fs.writeFileSync(targetFile, 'server.port=8080\npayment.timeout=3000\napp.env=prod\n', 'utf-8');

    const harnessReject = new AgentHarness({
      gateway: mockGateway,
      registry,
      context: { repoPath: TEST_DIR },
    });

    let rejectEmitted = false;
    const answerReject = await harnessReject.run('请将环境配置修改为 test', (event) => {
      if (event.type === 'approval_requested') {
        rejectEmitted = true;
        console.log('   -> 捕获到审批请求，模拟员工选择【❌ 拒绝修改】...');
        event.resolve(false); // 拒绝
      }
    });

    console.log('   Harness 拒绝后最终输出:', answerReject);
    const toolMsg = harnessReject.getMessages().find((m) => m.role === 'tool' && String(m.content).includes('拒绝'));
    if (!toolMsg) {
      throw new Error('拒绝后未能向模型回填结构化拒绝提示');
    }
    console.log('   回填给模型的 Tool Observation:\n', toolMsg.content);
    console.log('   ✅ 审批门拒绝流程完整，文件未被修改且模型正确收到反馈！');

    console.log('\n======================================================');
    console.log('🎉 所有 P2 阶段文件编辑与审批门测试全部顺利通过！');
    console.log('======================================================\n');
  } finally {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
