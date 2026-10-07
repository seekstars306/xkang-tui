import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { ServerConfig } from './types.js';

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

  const activeModelPath = path.resolve(serverDir, 'active_model.json');

  // tokens.json 默认放在 server/data/ 下，基于 serverDir 解析
  const defaultTokensJsonPath = path.resolve(serverDir, 'data', 'tokens.json');

  return {
    port,
    tokens,
    adminTokens,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash-high',
    grokApiKey: process.env.GROK_API_KEY,
    grokBaseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1',
    grokModel: process.env.GROK_MODEL || 'grok-4.6-medium',
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
