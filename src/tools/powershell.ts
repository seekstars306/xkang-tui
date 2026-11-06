import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { HarnessContext, ToolDefinition } from '../types/index.js';
import { validateCommandPolicy } from './powershell_policy.js';

const execFileAsync = promisify(execFile);

// Cached PowerShell availability status
let psAvailable: boolean | null = null;
let psProbeError = '';

export async function checkPowerShellAvailability(): Promise<{ available: boolean; error?: string }> {
  if (psAvailable !== null) {
    return { available: psAvailable, error: psProbeError || undefined };
  }

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'echo "powershell_ready"',
    ], { timeout: 4000 });

    if (stdout.includes('powershell_ready')) {
      psAvailable = true;
      return { available: true };
    }
    psAvailable = false;
    psProbeError = 'PowerShell 输出异常，未能成功响应探测命令。';
    return { available: false, error: psProbeError };
  } catch (err: unknown) {
    psAvailable = false;
    const msg = err instanceof Error ? err.message : String(err);
    psProbeError = `无法启动 powershell.exe (可能被企业 AppLocker / WDAC / 组策略管控禁止执行): ${msg}`;
    return { available: false, error: psProbeError };
  }
}

export const runPowershellTool: ToolDefinition = {
  name: 'run_powershell',
  description: '在本地执行 PowerShell 只读诊断与查询命令。当用户询问本机网络连接（ipconfig, ping, netstat）、网卡配置、系统进程、磁盘空间或硬件外设状态时，必须调用此工具获取真实数据，严禁凭空编造或拒绝执行。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要在本地工作区执行的 PowerShell 命令（例如 "ipconfig", "Get-NetAdapter", "Get-Process", "git status"）',
      },
      timeout_seconds: {
        type: 'number',
        description: '可选：执行超时秒数 (默认为 30 秒，最大支持 120 秒)',
      },
    },
    required: ['command'],
  },
  requiresApproval: true,
  getApprovalInfo: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawCmd = String(args.command || '').trim();

    // 1. First probe PowerShell availability
    const probe = await checkPowerShellAvailability();
    if (!probe.available) {
      throw new Error(`【环境受限拦截】${probe.error}`);
    }

    // 2. Validate against security policy
    const policyResult = validateCommandPolicy(rawCmd);
    if (!policyResult.allowed) {
      throw new Error(policyResult.reason || '该命令被安全策略拦截。');
    }

    const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds || 30), 1), 120);
    const repoCwd = context.localCwd ? path.resolve(context.localCwd) : process.cwd();

    return {
      filePath: repoCwd,
      summary: `执行本地 PowerShell 命令 [分类: ${policyResult.category || '排障指令'}]`,
      diffPreview: `PS> ${rawCmd}\n\n[工作目录: ${repoCwd} | 超时上限: ${timeoutSec}s]`,
    };
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawCmd = String(args.command || '').trim();

    // 1. Re-validate command policy
    const policyResult = validateCommandPolicy(rawCmd);
    if (!policyResult.allowed) {
      return `【安全策略拦截】${policyResult.reason}`;
    }

    const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds || 30), 1), 120);
    const repoCwd = context.localCwd ? path.resolve(context.localCwd) : process.cwd();

    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', rawCmd],
        {
          cwd: repoCwd,
          timeout: timeoutSec * 1000,
          maxBuffer: 1024 * 1024 * 5,
        }
      );

      let combinedOutput = (stdout || '') + (stderr ? `\n[STDERR]\n${stderr}` : '');
      combinedOutput = combinedOutput.trim();

      if (!combinedOutput) {
        combinedOutput = '(命令执行成功，无标准输出)';
      }

      // Max output truncate (16000 chars)
      const MAX_CHARS = 16000;
      if (combinedOutput.length > MAX_CHARS) {
        combinedOutput =
          combinedOutput.slice(0, MAX_CHARS) +
          `\n\n... [输出内容过长已截断，共 ${combinedOutput.length} 字符]`;
      }

      return `${combinedOutput}\n\n[exit code: 0]`;
    } catch (err: any) {
      if (err?.killed) {
        return `【命令执行超时】命令在运行超过 ${timeoutSec} 秒后被系统强行终止。\n[exit code: timeout]`;
      }

      const stdoutPart = err?.stdout ? `${err.stdout}\n` : '';
      const stderrPart = err?.stderr ? `[STDERR]\n${err.stderr}\n` : '';
      const errorMsg = err?.message || String(err);
      const exitCode = typeof err?.code === 'number' ? err.code : 1;

      return `${stdoutPart}${stderrPart}执行异常: ${errorMsg}\n\n[exit code: ${exitCode}]`;
    }
  },
};
