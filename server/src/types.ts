export interface AuthUser {
  token: string;
  name: string;
  subjectId?: string;
}

/** 特性开关（R5）。inputGuard 承载已合入的 S6 安全修复，默认必须开启；其余默认关闭，灰度后打开 */
export interface FeatureFlags {
  partialPublish: boolean;
  timeBudget: boolean;
  inputGuard: boolean;
  feedbackBinding: boolean;
}

/** 与 loadServerConfig() 的默认值一致：S6 脱敏默认开，其余默认关 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = { partialPublish: false, timeBudget: false, inputGuard: true, feedbackBinding: false };

export interface ServerConfig {
  port: number;
  tokens: Map<string, string>; // token -> employee name
  adminTokens: Map<string, string>;
  features: FeatureFlags;
  deepseekApiKey?: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  geminiApiKey?: string;
  geminiBaseUrl: string;
  geminiModel: string;
  geminiReasoningEffort?: 'high' | 'default';
  /** deepseek 排查调用的推理档位；缺省不传 reasoning_effort（与引入前一致），复核调用不受影响 */
  deepseekReasoningEffort?: 'low' | 'high' | 'max';
  /** 排查请求的上下文压缩阈值（估算 token）；缺省用 agent-core 的 140000 */
  contextTokens?: number;
  /** 复核调用的思考档位（M3 实验用）；缺省时沿用 geminiReasoningEffort */
  reviewReasoningEffort?: 'default' | 'low' | 'high';
  answerReviewTimeoutMs: number; // loadServerConfig 总是赋值并校验（60000–300000），复核调用必须显式拿到预算
  modelCallTimeoutMs: number; // 非复核模型调用上限（30000–600000，默认 240000）
  /** V4 数据核对模式：涉及 unknown 档位仓库时只放行数据事实（默认关，随 G5 设计批准后开） */
  dataOnlyForUnknown: boolean;
  /**
   * 出站 HTTP 代理（http://host:port）。用于访问被地域限制或需要固定出口的外部服务
   * （如 TypeSafe/Jev 在部分地区返回 451）。为空时直连，行为与引入该配置前一致。
   */
  outboundProxy?: string;
  /**
   * 复核器选择：'llm'（默认，现有 reviewAnswer）或 'jev'（TypeSafe System One）。
   * 两者产出的 ReviewDecision 同构，可并列测试；缺省保持 'llm'，行为与引入前一致。
   */
  reviewer: 'llm' | 'jev';
  /** 监控台登录账号（用户名 + scrypt 哈希）；为空时监控台禁止登录，不会退化成无鉴权 */
  /**
   * 独立的复核模型（可选）。
   *
   * 复核只看已经查出来的答案，不查库、不看代码，所以可以用更强但上下文更短的模型。
   * 一旦它请求失败或超时，立刻降级回原来的复核模型——复核不能因为换了个模型就停摆。
   */
  reviewModel?: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number } | null;
  /**
   * 独立复核模型的提示词预算（token）。
   * 它上下文很短，只该看"答了什么 + 够抽查的依据"，不该把整个项目的代码和库表行重读一遍。
   */
  reviewMaxPromptTokens?: number;
  monitorAccounts: Array<{ username: string; passwordHash: string }>;
  /** 会话 Cookie 的 HMAC 密钥；未配置时进程启动随机生成，重启后需重新登录 */
  monitorSessionSecret: string;
  /** 意图分流旁路观察：开启后每条输入都会分类并写 audit，但不改变路由（默认关） */
  observeIntentRouter: boolean;
  grokApiKey?: string;
  grokBaseUrl: string;
  grokModel: string;
  codeGraphEndpoint?: string;
  repoAllowlist: string[];
  codeRepoPath?: string;
  auditLogPath: string;
  rateLimitPerMinute: number;
  activeModelPath: string;
  defaultActiveModel?: string;
  tokensJsonPath: string;
  codeSyncIntervalMinutes?: number;
  mockLlm: boolean;
  enableL1?: boolean;
  enableL2?: boolean;
}

export interface AuditRecord {
  timestamp: string;
  user: string;
  type: 'tool_call' | 'llm_chat' | 'auth_failure' | 'admin_action';
  toolName?: string;
  model?: string;
  details?: Record<string, unknown>;
  tokensUsed?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    totalTokens: number;
  };
  durationMs?: number;
  success: boolean;
  error?: string;
}
