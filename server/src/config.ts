import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ServerConfig, type FeatureFlags } from './types.js';
import { validateReviewMode } from './agent/review_mode.js';
import { validateAnswerGuide } from './agent/answer_guide.js';
import { validateIdCheck } from './agent/id_coverage.js';

// Resolve the server root directory robustly:
// - When running from project root (cwd = .../xkang-tui), .env is at cwd/server/.env
// - When running from server/ subdir (cwd = .../xkang-tui/server), .env is at cwd/.env
// - When running from server/dist/, .env is at cwd/../.env
function resolveServerDir(): string {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'server'),  // project root
    cwd,                           // server/ subdir
    path.resolve(cwd, '..'),       // server/dist/
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.env'))) return c;
  }
  return path.resolve(cwd, 'server');
}

const serverDir = resolveServerDir();
const serverEnvPath = path.join(serverDir, '.env');
dotenv.config({ path: serverEnvPath });

export function loadServerConfig(): ServerConfig {
  const port = parseInt(process.env.PORT || '8090', 10);
  const geminiReasoningEffort = process.env.GEMINI_REASONING_EFFORT || 'high';
  if (geminiReasoningEffort !== 'high' && geminiReasoningEffort !== 'default') throw new Error('GEMINI_REASONING_EFFORT must be high or default');
  // 复核思考档位：缺省沿用调查档位；M3 实验用它单独对照 default/low/high
  const reviewReasoningEffort = process.env.REVIEW_REASONING_EFFORT || geminiReasoningEffort;
  if (reviewReasoningEffort !== 'default' && reviewReasoningEffort !== 'low' && reviewReasoningEffort !== 'high') throw new Error('REVIEW_REASONING_EFFORT must be default, low or high');
  // deepseek 排查调用的推理档位：缺省不传（与引入前一致）。2026-10-29 同模型对照发现 zcode 以 high 调用同一个接口、
  // 有推理过程，而 xkang 的推理 token 恒为 0；同一道日期题不推理答错、推理后答对。
  const deepseekReasoningEffort = (process.env.DEEPSEEK_REASONING_EFFORT || '').trim() || undefined;
  if (deepseekReasoningEffort && !['low', 'high', 'max'].includes(deepseekReasoningEffort)) throw new Error('DEEPSEEK_REASONING_EFFORT must be low, high or max');
  // 上下文压缩阈值：缺省不设（agent-core 默认 140000）。跨框架对照时设成与其他框架声明的上下文窗口相同。
  const contextTokensRaw = (process.env.CONTEXT_TOKENS || '').trim();
  const contextTokens = contextTokensRaw ? Number(contextTokensRaw) : undefined;
  if (contextTokens !== undefined && !(Number.isInteger(contextTokens) && contextTokens >= 8000)) throw new Error('CONTEXT_TOKENS must be an integer >= 8000');

  // 特性开关（R5）：inputGuard 是已合入的 S6 安全修复，默认开启（仅 '0'/'false' 关闭）；其余默认关闭（仅 '1'/'true' 开启）
  const enabled = (value: string | undefined, fallback: boolean) => {
    if (value === undefined || value === '') return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true'].includes(normalized)) return true;
    if (['0', 'false'].includes(normalized)) return false;
    throw new Error(`特性开关取值必须为 1/true 或 0/false: ${value}`);
  };
  const features: FeatureFlags = {
    partialPublish: enabled(process.env.FEATURE_PARTIAL_PUBLISH, false),
    timeBudget: enabled(process.env.FEATURE_TIME_BUDGET, false),
    inputGuard: enabled(process.env.FEATURE_INPUT_GUARD, true),
    feedbackBinding: enabled(process.env.FEATURE_FEEDBACK_BINDING, false),
  };
  // V4 数据核对模式开关（默认关：改变答案形态，随 G5 设计批准后开启）
  const dataOnlyForUnknown = enabled(process.env.DATA_ONLY_FOR_UNKNOWN, false);
  const answerReviewTimeoutMs = Number(process.env.ANSWER_REVIEW_TIMEOUT_MS || '180000');
  if (!Number.isInteger(answerReviewTimeoutMs) || answerReviewTimeoutMs < 60000 || answerReviewTimeoutMs > 300000) throw new Error('ANSWER_REVIEW_TIMEOUT_MS must be between 60000 and 300000');
  const modelCallTimeoutMs = Number(process.env.MODEL_CALL_TIMEOUT_MS || '240000');
  if (!Number.isInteger(modelCallTimeoutMs) || modelCallTimeoutMs < 30000 || modelCallTimeoutMs > 600000) throw new Error('MODEL_CALL_TIMEOUT_MS must be between 30000 and 600000');
  
  // Format: XKANG_TOKENS="tok_alice_123:Alice,tok_bob_456:Bob"
  const tokensRaw = process.env.XKANG_TOKENS || 'tok_dev_001:测试员工';
  const tokens = new Map<string, string>();
  for (const pair of tokensRaw.split(',')) {
    const [t, name] = pair.trim().split(':');
    if (t && name) {
      tokens.set(t.trim(), name.trim());
    }
  }

  // Format: XKANG_ADMIN_TOKENS="admin_secret_token:SuperAdmin"
  const adminTokensRaw = process.env.XKANG_ADMIN_TOKENS || 'admin_secret_token_123:DefaultAdmin';
  const adminTokens = new Map<string, string>();
  for (const pair of adminTokensRaw.split(',')) {
    const [t, name] = pair.trim().split(':');
    if (t && name) {
      adminTokens.set(t.trim(), name.trim());
    }
  }

  // Comma-separated list of allowed repository names/paths
  const repoAllowlistRaw = process.env.REPO_ALLOWLIST || '*';
  const repoAllowlist = repoAllowlistRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const mockLlm = process.env.XKANG_LLM_MOCK === '1' || process.env.XKANG_LLM_MOCK === 'true';

  const enableL1 = process.env.ENABLE_L1 !== '0' && process.env.ENABLE_L1 !== 'false';
  const enableL2 = process.env.ENABLE_L2 !== '0' && process.env.ENABLE_L2 !== 'false';

  // 出站 HTTP 代理（可选）：http://host:port。用于访问被地域限制的外部服务（如 TypeSafe 在部分地区返回 451）。
  // 留空 = 直连，与引入该配置前的行为一致。只接受 http:// 形式，避免把 https/socks 误配成不可用状态却不报错。
  const outboundProxyRaw = (process.env.OUTBOUND_PROXY || '').trim();
  if (outboundProxyRaw && !/^http:\/\/[^\s/]+(:\d+)?$/i.test(outboundProxyRaw)) {
    throw new Error(`OUTBOUND_PROXY 必须是 http://host:port 形式，当前值：${outboundProxyRaw}`);
  }
  const outboundProxy = outboundProxyRaw || undefined;

  // 复核器：llm（默认，行为不变）| jev（TypeSafe System One）。用于把 xkang 与 xkang-jev 并列测试。
  const reviewerRaw = (process.env.REVIEWER || 'llm').trim().toLowerCase();
  if (reviewerRaw !== 'llm' && reviewerRaw !== 'jev') {
    throw new Error(`REVIEWER 只能是 llm 或 jev，当前值：${reviewerRaw}`);
  }
  const reviewer = reviewerRaw as 'llm' | 'jev';
  // 复核模式 REVIEW_MODE（gate 默认 / advisory / off，见 agent/review_mode.ts）：每轮排查开始时从 env 读取；
  // 这里只在启动时校验取值，写错直接报错，而不是让对照实验悄悄按 gate 跑
  validateReviewMode();
  validateAnswerGuide();
  validateIdCheck();
  // 独立复核模型：只做复核，不查库/不看代码。配了才启用，没配就走原复核链路
  const reviewBaseUrl = process.env.REVIEW_MODEL_BASE_URL;
  const reviewApiKey = process.env.REVIEW_MODEL_API_KEY;
  const reviewModelName = process.env.REVIEW_MODEL_NAME;
  const reviewModel = reviewBaseUrl && reviewApiKey && reviewModelName
    ? {
        baseUrl: reviewBaseUrl,
        apiKey: reviewApiKey,
        model: reviewModelName,
        timeoutMs: Number(process.env.REVIEW_MODEL_TIMEOUT_MS || 120000),
      }
    : null;

  // 监控台账号：XKANG_MONITOR_ACCOUNTS="admin:<scrypt hash>,ops:<scrypt hash>"
  // 密码用 hashPassword() 生成；未配置时监控台不可登录（不会退化成无鉴权）。
  const monitorAccountsRaw = (process.env.XKANG_MONITOR_ACCOUNTS || '').trim();
  const monitorAccounts = monitorAccountsRaw
    ? monitorAccountsRaw.split(',').map(pair => {
        const idx = pair.indexOf(':');
        return { username: pair.slice(0, idx).trim(), passwordHash: pair.slice(idx + 1).trim() };
      }).filter(a => a.username && a.passwordHash)
    : [];
  // 会话签名密钥：没配就生成一次性的（重启后需重新登录，但不会用固定弱密钥）
  const monitorSessionSecret = (process.env.XKANG_MONITOR_SECRET || '').trim() || randomBytes(32).toString('hex');

  // 意图分流旁路观察：默认关。开启后每条输入都会问一次 Jev 并写进 audit，但不改变任何路由。
  const observeIntentRouter = enabled(process.env.OBSERVE_INTENT_ROUTER, false);

  const activeModelPath = path.resolve(serverDir, 'active_model.json');

  // tokens.json 默认放在 server/data/ 下，基于 serverDir 解析
  const defaultTokensJsonPath = path.resolve(serverDir, 'data', 'tokens.json');

  return {
    port,
    tokens,
    adminTokens,
    features,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    deepseekReasoningEffort: deepseekReasoningEffort as ServerConfig['deepseekReasoningEffort'],
    contextTokens,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash-high',
    geminiReasoningEffort,
    reviewReasoningEffort,
    answerReviewTimeoutMs,
    reviewModel,
    // 上下文有 300k，不需要压得太狠；这里只防"整包过大"这一种极端情况
    reviewMaxPromptTokens: Number(process.env.REVIEW_MAX_PROMPT_TOKENS || 80000),
    modelCallTimeoutMs,
    dataOnlyForUnknown,
    grokApiKey: process.env.GROK_API_KEY,
    grokBaseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1',
    grokModel: process.env.GROK_MODEL || 'grok-4.6-medium',
    outboundProxy,
    monitorAccounts,
    monitorSessionSecret,
    reviewer,
    observeIntentRouter,
    codeGraphEndpoint: process.env.CODEGRAPH_ENDPOINT || 'http://localhost:8080/codegraph',
    repoAllowlist,
    codeRepoPath: process.env.CODE_REPO_PATH || '',
    auditLogPath: process.env.AUDIT_LOG_PATH ? path.resolve(process.env.AUDIT_LOG_PATH) : path.resolve(serverDir, 'audit.jsonl'),
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '120', 10),
    activeModelPath: process.env.ACTIVE_MODEL_PATH ? path.resolve(process.env.ACTIVE_MODEL_PATH) : activeModelPath,
    defaultActiveModel: process.env.ACTIVE_MODEL || process.env.DEFAULT_MODEL,
    tokensJsonPath: process.env.TOKENS_JSON_PATH ? path.resolve(process.env.TOKENS_JSON_PATH) : defaultTokensJsonPath,
    codeSyncIntervalMinutes: parseInt(process.env.CODE_SYNC_INTERVAL_MINUTES || '10', 10),
    mockLlm,
    enableL1,
    enableL2,
  };
}
