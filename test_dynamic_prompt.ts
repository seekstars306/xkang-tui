import { buildSystemPrompt } from './src/harness/system_prompt.js';
import { AgentHarness } from './src/harness/agent.js';
import { ModelGateway } from './src/adapters/gateway.js';
import { ToolRegistry } from './src/tools/registry.js';
import { AppConfig } from './src/config/models.js';
import { HarnessContext, MessageContentPart } from './src/types/index.js';

function runTests() {
  console.log('===============================================================');
  console.log('🚀 开始验证：视觉排障与平台归属判定提示词【按需动态加载】机制');
  console.log('===============================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${msg}`);
    }
  }

  // -------------------------------------------------------------
  // Test 1: 纯文本场景下的 buildSystemPrompt（无图片）
  // -------------------------------------------------------------
  const promptTextOnly = buildSystemPrompt([], [], 'l2', { hasImages: false });
  assert(
    !promptTextOnly.includes('【视觉截图排障与平台归属判定准则（当前会话已提供图片）】'),
    '纯文本模式下未注入截图定位与平台归属判定段落 (节省 Token)'
  );
  assert(
    !promptTextOnly.includes('【分支决策与硬性熔断机制】'),
    '纯文本模式下未包含外部平台甄别与熔断冗余描述'
  );
  assert(
    promptTextOnly.includes('【真实数据优先铁律】'),
    '纯文本模式下保留核心真实数据优先原则'
  );

  // -------------------------------------------------------------
  // Test 2: 包含图片场景下的 buildSystemPrompt（有图片）
  // -------------------------------------------------------------
  const promptWithImages = buildSystemPrompt([], [], 'l2', { hasImages: true });
  assert(
    promptWithImages.includes('【视觉截图排障与平台归属判定准则（当前会话已提供图片）】'),
    '包含图片时自动注入截图与平台归属判定段落'
  );
  assert(
    promptWithImages.includes('【分支决策与硬性熔断机制】'),
    '包含图片时包含外部平台甄别与硬性熔断规则'
  );
  assert(
    promptWithImages.includes('ask_user_question'),
    '包含图片时明确指引似是而非时调用 ask_user_question'
  );
  assert(
    promptWithImages.includes('明确确认为我方平台'),
    '包含图片时明确确认为我方平台时直接排障、严禁打扰客服'
  );

  // -------------------------------------------------------------
  // Test 3: AgentHarness 上下文动态感知测试
  // -------------------------------------------------------------
  const mockConfig: AppConfig = {
    defaultModel: 'gemini-3.7-flash',
    geminiApiKey: 'mock-key',
  };
  const gateway = new ModelGateway(mockConfig);
  const registry = new ToolRegistry([]);
  const context: HarnessContext = {
    repoPath: process.cwd(),
    localCwd: process.cwd(),
  };

  const agent = new AgentHarness({
    gateway,
    registry,
    context,
  });

  // 初始状态（纯文本）
  const initialSystemMsg = agent.getMessages()[0].content as string;
  assert(
    !initialSystemMsg.includes('【视觉截图排障与平台归属判定准则'),
    'Agent 初始状态提示词为精简纯文本状态'
  );

  // 模拟发送一张图片
  const imageInput: MessageContentPart[] = [
    { type: 'text', text: '客服发来一张改签报错截图，请看' },
    {
      type: 'image_url',
      image_url: {
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    },
  ];

  agent.getMessages().push({
    role: 'user',
    content: imageInput,
  });

  // 触发刷新
  agent.refreshSystemPrompt();
  const refreshedSystemMsg = agent.getMessages()[0].content as string;
  assert(
    refreshedSystemMsg.includes('【视觉截图排障与平台归属判定准则（当前会话已提供图片）】'),
    'Agent 探测到图片后，自动将 System Prompt 升级为包含视觉排障与外部平台甄别规则'
  );

  // 测试 clearHistory 后恢复纯净状态
  agent.clearHistory();
  const clearedSystemMsg = agent.getMessages()[0].content as string;
  assert(
    !clearedSystemMsg.includes('【视觉截图排障与平台归属判定准则'),
    'Agent 清空会话后，System Prompt 自动重置为纯净无图片状态'
  );

  console.log('\n===============================================================');
  console.log(`📊 测试汇总: 总共 ${total} 项测试, 通过: ${passed}, 失败: ${total - passed}`);
  console.log('===============================================================');

  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
