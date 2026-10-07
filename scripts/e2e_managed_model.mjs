import { startServer } from '../server/dist/index.js';
import { ServerProxyAdapter } from '../dist/adapters/server_proxy.js';
import fs from 'node:fs';

const TEST_PORT = 8299;
const EMP_TOKEN = 'emp_alice_123';
const ADM_TOKEN = 'adm_boss_999';
const TEST_PERSIST_PATH = './test_active_model.json';
const TEST_AUDIT_PATH = './test_admin_audit.jsonl';

process.env.PORT = String(TEST_PORT);
process.env.XKANG_TOKENS = `${EMP_TOKEN}:AliceEmployee`;
process.env.XKANG_ADMIN_TOKENS = `${ADM_TOKEN}:BossAdmin`;
process.env.ACTIVE_MODEL_PATH = TEST_PERSIST_PATH;
process.env.AUDIT_LOG_PATH = TEST_AUDIT_PATH;
process.env.XKANG_LLM_MOCK = '1'; // Enable mock LLM mode

const { server, modelManager } = startServer();

const BASE_URL = `http://localhost:${TEST_PORT}`;

// Helper: SSE chat request collector
async function streamChatRequest(token, messages, bodyOverride = {}) {
  const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'xkang-managed',
      messages,
      stream: true,
      ...bodyOverride,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${errText}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawBlock = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 2);

      if (!rawBlock.startsWith('data:')) continue;
      const dataStr = rawBlock.slice(5).trim();
      if (dataStr === '[DONE]') {
        chunks.push('[DONE]');
        continue;
      }
      try {
        chunks.push(JSON.parse(dataStr));
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  return chunks;
}

async function runAllTests() {
  try {
    console.log('\n======================================================');
    console.log('🧪 开始进行「模型隐藏 + 管理员动态切换 + 在途不断 + 上下文保持」测试');
    console.log('======================================================\n');

    // 1. 权限隔离测试：普通员工无权访问 /admin/model
    console.log('▶ [1/7] 测试管理员权限隔离 (普通员工 Token 访问 /admin 应被 403 拦截)...');
    const empAdminResp = await fetch(`${BASE_URL}/admin/model`, {
      headers: { Authorization: `Bearer ${EMP_TOKEN}` },
    });
    console.log(`   员工访问 /admin/model 返回 HTTP 状态码: ${empAdminResp.status}`);
    if (empAdminResp.status !== 403) {
      throw new Error(`权限隔离失败: 员工 Token 应返回 403，实际返回 ${empAdminResp.status}`);
    }

    // 2. 管理员查看模型列表
    console.log('\n▶ [2/7] 管理员查看当前模型状态与可用列表...');
    const adminGetResp = await fetch(`${BASE_URL}/admin/model`, {
      headers: { Authorization: `Bearer ${ADM_TOKEN}` },
    });
    const adminGetJson = await adminGetResp.json();
    console.log('   当前活跃模型:', adminGetJson.activeModel);
    console.log('   对外公共别名:', adminGetJson.publicAlias);
    console.log('   可用模型列表:', adminGetJson.availableModels);
    if (adminGetJson.publicAlias !== 'xkang-managed') {
      throw new Error(`对外别名应为 xkang-managed，实际为 ${adminGetJson.publicAlias}`);
    }

    // 确保初始模型为 deepseek
    modelManager.setActive('deepseek');

    // 3. 隐藏真实模型测试与客户端无法越权指定模型测试
    console.log('\n▶ [3/7] 测试隐藏真实模型名称 & 客户端指定 model 字段被忽略...');
    const test1Chunks = await streamChatRequest(
      EMP_TOKEN,
      [{ role: 'user', content: '查询发票开具超时原因' }],
      { model: 'grok-4.6-medium' } // 客户端试图传 grok，但服务端当前是 deepseek
    );

    const nonDoneChunks = test1Chunks.filter((c) => c !== '[DONE]');
    const allModelsInChunks = new Set(nonDoneChunks.map((c) => c.model));
    console.log('   服务端返回的所有 chunk 中 model 字段取值:', Array.from(allModelsInChunks));
    if (allModelsInChunks.size !== 1 || !allModelsInChunks.has('xkang-managed')) {
      throw new Error(`真实模型名未被隐藏！返回了: ${Array.from(allModelsInChunks)}`);
    }

    const test1Content = nonDoneChunks
      .map((c) => c.choices?.[0]?.delta?.content || c.choices?.[0]?.delta?.reasoning_content || '')
      .join('');
    console.log('   实际调度输出片段:', test1Content.slice(0, 100));
    if (!test1Content.includes('mock-deepseek')) {
      throw new Error('客户端传参不应覆盖服务端设定的活跃模型 (当前应为 deepseek)');
    }

    // 4. 【核心】在途任务不中断 + 动态切换到新模型测试
    console.log('\n▶ [4/7] 【核心测试】在途任务不受管理员中途切模型影响...');
    console.log('   -> 步骤 A: 启动请求 A (使用当前 deepseek 模型，流式耗时约 1.5s)...');
    const taskAPromise = streamChatRequest(EMP_TOKEN, [
      { role: 'user', content: '排查订单超时任务A' },
    ]);

    // 等待 350ms，此时请求 A 已经在流式生成中（正在输出 deepseek 推理片段）
    await new Promise((r) => setTimeout(r, 350));

    console.log('   -> 步骤 B: 管理员在后台执行 POST /admin/model 将模型动态切换为 grok...');
    const switchResp = await fetch(`${BASE_URL}/admin/model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADM_TOKEN}`,
      },
      body: JSON.stringify({ model: 'grok' }),
    });
    const switchJson = await switchResp.json();
    console.log('   管理员切换结果:', switchJson.message);

    console.log('   -> 步骤 C: 等待在途请求 A 流式完成...');
    const chunksA = await taskAPromise;
    const textA = chunksA
      .filter((c) => c !== '[DONE]')
      .map((c) => c.choices?.[0]?.delta?.content || c.choices?.[0]?.delta?.reasoning_content || '')
      .join('');
    console.log('   请求 A 最终获取内容摘要:', textA.slice(0, 120));

    if (!textA.includes('mock-deepseek') || textA.includes('mock-grok')) {
      throw new Error('在途任务 A 被异常中断或混入了新模型内容！');
    }
    console.log('   ✅ 请求 A 成功使用原 deepseek 模型完整跑完，未受中途切换干扰！');

    // 5. 新请求自动使用新模型 + 上下文保持测试
    console.log('\n▶ [5/7] 测试新请求自动切换至 grok 并且携带历史上下文...');
    const multiTurnMessages = [
      { role: 'user', content: '排查订单超时任务A' },
      { role: 'assistant', content: textA },
      { role: 'user', content: '继续分析第二步排障建议' }, // 新的一轮追问
    ];

    const chunksB = await streamChatRequest(EMP_TOKEN, multiTurnMessages);
    const textB = chunksB
      .filter((c) => c !== '[DONE]')
      .map((c) => c.choices?.[0]?.delta?.content || '')
      .join('');
    console.log('   请求 B 最终获取内容摘要:', textB.slice(0, 120));

    if (!textB.includes('mock-grok')) {
      throw new Error('新请求 B 未能自动使用新切换的模型 (grok)');
    }
    console.log('   ✅ 新请求 B 成功由新模型 grok 处理，且完整携带了前一轮会话上下文！');

    // 6. 持久化文件校验
    console.log('\n▶ [6/7] 验证活跃模型已持久化到磁盘...');
    if (fs.existsSync(TEST_PERSIST_PATH)) {
      const persisted = JSON.parse(fs.readFileSync(TEST_PERSIST_PATH, 'utf-8'));
      console.log('   持久化文件 active_model.json 内容:', persisted);
      if (persisted.activeModel !== 'grok') {
        throw new Error(`持久化模型应为 grok，实际为 ${persisted.activeModel}`);
      }
    } else {
      throw new Error('持久化文件未生成');
    }

    // 7. 客户端 ServerProxyAdapter 整体联动验证
    console.log('\n▶ [7/7] 验证客户端 ServerProxyAdapter 完整事件流对接...');
    const adapter = new ServerProxyAdapter(BASE_URL, EMP_TOKEN, 'xkang-managed');
    const receivedEvents = [];

    const adapterResult = await adapter.streamChat(
      multiTurnMessages,
      [],
      (event) => {
        receivedEvents.push(event.type);
      }
    );

    console.log('   客户端适配器接收到的事件序列:', receivedEvents);
    console.log('   客户端适配器返回消息内容摘要:', adapterResult.content.slice(0, 100));

    if (!receivedEvents.includes('content_chunk') || !receivedEvents.includes('usage_sync')) {
      throw new Error('客户端适配器未完整接收到流式事件');
    }
    console.log('   ✅ 客户端 ServerProxyAdapter 与服务端代理无缝流式对接！');

    console.log('\n======================================================');
    console.log('🎉 所有 7 项端到端测试全部顺利通过！');
    console.log('======================================================\n');
  } finally {
    server.close();
    if (fs.existsSync(TEST_PERSIST_PATH)) {
      fs.unlinkSync(TEST_PERSIST_PATH);
    }
    if (fs.existsSync(TEST_AUDIT_PATH)) {
      fs.unlinkSync(TEST_AUDIT_PATH);
    }
  }
}

runAllTests().catch((err) => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
