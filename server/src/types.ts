export interface AuthUser {
  token: string;
  name: string;
}

export interface ServerConfig {
  port: number;
  tokens: Map<string, string>; // token -> employee name
  adminTokens: Map<string, string>; // admin token -> admin name
  deepseekApiKey?: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  geminiApiKey?: string;
  geminiBaseUrl: string;
  geminiModel: string;
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
