import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ModelProfile, ModelType } from '../types/index.js';
import { loadUserLocalConfig } from './user_config.js';

// 1. Standard cwd-based .env loading (dev mode & custom deployments)
dotenv.config();

// 2. Bundled .env at package root (src/config -> root in dev, dist/config -> bundle root in packaged exe).
//    Guarantees the packaged exe always reads its bundled config regardless of launch working directory.
try {
  const bundledEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (fs.existsSync(bundledEnvPath)) {
    dotenv.config({ path: bundledEnvPath });
  }
} catch {
  // ignore missing bundled env
}

export const UNIFIED_CONTEXT_WINDOW = 131072;
export const UNIFIED_COMPACTION_THRESHOLD = 98304;

export const SUPPORTED_MODELS: Record<ModelType, ModelProfile> = {
  'xkang-managed': {
    id: 'xkang-managed',
    displayName: '小康 TUI 业务排障集中调度底座 (Managed)',
    provider: 'managed',
    contextWindow: UNIFIED_CONTEXT_WINDOW,
    compactionThreshold: UNIFIED_COMPACTION_THRESHOLD,
    supportsNativeReasoning: true,
    supportsParallelTools: true,
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek-V4 Flash (深度推理与代码专家)',
    provider: 'deepseek',
    contextWindow: UNIFIED_CONTEXT_WINDOW,
    compactionThreshold: UNIFIED_COMPACTION_THRESHOLD,
    supportsNativeReasoning: true,
    supportsParallelTools: true,
  },
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash High (多模态排障)',
    provider: 'gemini',
    contextWindow: UNIFIED_CONTEXT_WINDOW,
    compactionThreshold: UNIFIED_COMPACTION_THRESHOLD,
    supportsNativeReasoning: false,
    supportsParallelTools: true,
  },
  'grok-4.6-medium': {
    id: 'grok-4.6-medium',
    displayName: 'Grok 4.6 Medium (日常通用与任务编排)',
    provider: 'grok',
    contextWindow: UNIFIED_CONTEXT_WINDOW,
    compactionThreshold: UNIFIED_COMPACTION_THRESHOLD,
    supportsNativeReasoning: false,
    supportsParallelTools: true,
  },
};

export interface AppConfig {
  defaultModel: ModelType;
  serverUrl?: string;
  token?: string;
  userName?: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  geminiApiKey: string;
  geminiBaseUrl?: string;
  grokApiKey: string;
  grokBaseUrl: string;
  codeRepoPath: string;
  codeGraphEndpoint?: string;
}

export function loadConfig(): AppConfig {
  const localConfig = loadUserLocalConfig();

  // Priority: CLI flags (handled in cli.tsx) > local user config (~/.xkang/config.json) > ambient env vars > default
  const serverUrl = localConfig.serverUrl || process.env.XKANG_SERVER_URL || 'http://10.197.15.89:8600';
  const token = localConfig.token || process.env.XKANG_TOKEN || undefined;
  const userName = localConfig.userName || undefined;

  return {
    defaultModel: (process.env.DEFAULT_MODEL as ModelType) || 'xkang-managed',
    serverUrl,
    token,
    userName,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiBaseUrl: process.env.GEMINI_BASE_URL,
    grokApiKey: process.env.GROK_API_KEY || '',
    grokBaseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1',
    codeRepoPath: localConfig.codeRepoPath || process.env.CODE_REPO_PATH || process.cwd(),
    codeGraphEndpoint: process.env.CODEGRAPH_ENDPOINT,
  };
}
