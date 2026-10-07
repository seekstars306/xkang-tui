import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface UserLocalConfig {
  serverUrl: string;
  token?: string;
  userName?: string;
  lastActivatedAt?: string;
  codeRepoPath?: string;
}

const DEFAULT_SERVER_URL = 'http://10.197.15.89:8600';
const DEFAULT_CODE_REPO_PATH = 'D:\\skt_project';

export function getUserConfigPath(): string {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.xkang');
  return path.join(configDir, 'config.json');
}

export function loadUserLocalConfig(): UserLocalConfig {
  const filePath = getUserConfigPath();
  if (!fs.existsSync(filePath)) {
    return {
      serverUrl: DEFAULT_SERVER_URL,
      codeRepoPath: DEFAULT_CODE_REPO_PATH,
    };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      serverUrl: parsed.serverUrl || DEFAULT_SERVER_URL,
      token: parsed.token || undefined,
      userName: parsed.userName || undefined,
      lastActivatedAt: parsed.lastActivatedAt || undefined,
      codeRepoPath: parsed.codeRepoPath || DEFAULT_CODE_REPO_PATH,
    };
  } catch {
    return {
      serverUrl: DEFAULT_SERVER_URL,
      codeRepoPath: DEFAULT_CODE_REPO_PATH,
    };
  }
}

export function saveUserLocalConfig(config: Partial<UserLocalConfig>): void {
  const filePath = getUserConfigPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const current = loadUserLocalConfig();
  const merged = { ...current, ...config };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
}

export function clearUserLocalConfig(): void {
  const filePath = getUserConfigPath();
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}
