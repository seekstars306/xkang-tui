export interface CommandValidationResult {
  allowed: boolean;
  category?: string;
  reason?: string;
}

// Allowed Read-Only Git Subverbs (Strict Hardcoded Set)
const GIT_STRICT_READONLY_VERBS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'branch',
  'tag',
  'rev-parse',
  'remote',
]);

// 1. Dangerous Blacklist Regexes (highest priority rejection)
const BLACKLIST_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(git\s+(commit|push|merge|rebase|reset|checkout\s+-[bB]|switch\s+-[cC]|tag\s+-[adfs]|clean|revert|cherry-pick|rm|mv|stash\s+(drop|pop|clear|apply)|branch\s+-[dDmM]|update-ref|apply|am|add)\b)/i,
    reason: '禁止执行任何 Git 修改、暂存、提交、合并、推送、重置、分支/标签变更或代码回滚操作（系统严格仅允许 Git 只读查询与溯源）。',
  },
  {
    pattern: /\b(rm\s+-rf|Remove-Item\b.*?-Recurse|del\s+.*\/s|rd\s+.*\/s|format\b|Clear-Disk)\b/i,
    reason: '禁止执行任何可能导致批量或递归删除的破坏性文件系统清理命令。',
  },
  {
    pattern: /\b(reg\s+(add|delete|import|restore)|Set-ExecutionPolicy|net\s+(user|localgroup|share)|netsh)\b/i,
    reason: '禁止执行任何修改系统注册表、安全策略、本地用户或网络配置的系统篡改命令。',
  },
  {
    pattern: /\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget|Start-BitsTransfer|DownloadFile|DownloadString)\b/i,
    reason: '禁止通过 PowerShell 发起网络请求（请使用受控的 web_fetch 工具以防内网探测）。',
  },
  {
    pattern: /\b(Start-Process\b.*?-Verb\s+RunAs|sudo|runas)\b/i,
    reason: '禁止尝试请求管理员提权或触发 UAC 交互。',
  },
  {
    pattern: /\b(iex\b|Invoke-Expression|-EncodedCommand|\[Convert\]::FromBase64String)\b/i,
    reason: '禁止使用动态代码求值或 Base64 编码命令绕过安全审查。',
  },
  {
    pattern: /\b(shutdown|restart-computer|stop-computer|taskkill\s+\/f)\b/i,
    reason: '禁止执行系统关机、重启或强杀进程操作。',
  },
];

// 2. Whitelist command prefixes — for category labeling only (not for access control)
const WHITELIST_PREFIXES: Array<{ prefix: string; category: string }> = [
  // Build & Test Verification
  { prefix: 'mvn test', category: 'Maven 单元测试验证' },
  { prefix: 'mvn -v', category: 'Maven 版本检查' },
  { prefix: 'mvn --version', category: 'Maven 版本检查' },
  { prefix: 'mvn -version', category: 'Maven 版本检查' },
  { prefix: 'npm test', category: 'NPM 测试验证' },
  { prefix: 'npm run test', category: 'NPM 测试验证' },
  { prefix: 'npm run check', category: 'NPM 类型与语法检查' },
  { prefix: 'npm run lint', category: 'NPM 代码检查' },
  { prefix: 'npm run build', category: 'NPM 构建验证' },
  { prefix: 'npm run typecheck', category: 'NPM 类型检查' },
  { prefix: 'npm -v', category: 'NPM 版本' },
  { prefix: 'npm --version', category: 'NPM 版本' },
  { prefix: 'node -v', category: 'Node.js 版本' },
  { prefix: 'node --version', category: 'Node.js 版本' },
  { prefix: 'pnpm test', category: 'pnpm 测试' },
  { prefix: 'yarn test', category: 'yarn 测试' },
  { prefix: 'gradle test', category: 'Gradle 测试' },
  { prefix: 'gradle -v', category: 'Gradle 版本' },

  // Environment & Runtime Inspection
  { prefix: 'java -version', category: 'Java 环境检查' },
  { prefix: 'java --version', category: 'Java 环境检查' },
  { prefix: 'javac -version', category: 'Javac 编译器检查' },
  { prefix: 'javac --version', category: 'Javac 编译器检查' },
  { prefix: 'python --version', category: 'Python 环境检查' },
  { prefix: 'python -V', category: 'Python 环境检查' },

  // Safe Read-only PowerShell Cmdlets & Network / System Inspection
  { prefix: 'ipconfig', category: '本地网络配置查看' },
  { prefix: 'Get-NetIPAddress', category: '本机 IP 地址查询' },
  { prefix: 'Get-NetAdapter', category: '网卡适配器查看' },
  { prefix: 'Get-NetTCPConnection', category: '网络连接状态查看' },
  { prefix: 'hostname', category: '主机名查询' },
  { prefix: 'netstat', category: '网络端口连接查看' },
  { prefix: 'systeminfo', category: '系统配置信息查看' },
  { prefix: 'Get-Content', category: '文件只读查看' },
  { prefix: 'Get-ChildItem', category: '目录列表查看' },
  { prefix: 'Get-Item', category: '文件元数据查看' },
  { prefix: 'Select-String', category: '字符串匹配检索' },
  { prefix: 'Get-Process', category: '系统进程查看' },
  { prefix: 'Get-Service', category: '系统服务查看' },
  { prefix: 'Get-Command', category: '命令信息查询' },
  { prefix: 'Get-Help', category: '帮助文档查看' },
  { prefix: 'Test-Path', category: '路径存在性校验' },
  { prefix: 'Get-Date', category: '系统时间查询' },
  { prefix: 'Get-Location', category: '当前路径查看' },
  { prefix: 'Get-PnpDevice', category: '即插即用设备查询(蓝牙/USB等)' },
  { prefix: 'Get-CimInstance', category: '系统硬件/WMI 信息查询' },
  { prefix: 'Get-WmiObject', category: '系统硬件/WMI 信息查询' },
  { prefix: 'Get-ComputerInfo', category: '计算机综合信息查询' },
  { prefix: 'Get-Volume', category: '磁盘卷信息查询' },
  { prefix: 'Get-Disk', category: '物理磁盘信息查询' },
  { prefix: 'Get-Partition', category: '磁盘分区信息查询' },
  { prefix: 'Get-PhysicalDisk', category: '物理磁盘信息查询' },
  { prefix: 'Get-NetRoute', category: '网络路由查看' },
  { prefix: 'Get-DnsClientServerAddress', category: 'DNS 配置查看' },
  { prefix: 'Get-NetFirewallRule', category: '防火墙规则查看' },
  { prefix: 'Test-NetConnection', category: '网络连通性测试' },
  { prefix: 'Resolve-DnsName', category: 'DNS 解析查询' },
  { prefix: 'nslookup', category: 'DNS 解析查询' },
  { prefix: 'ping', category: '网络连通性测试' },
  { prefix: 'tracert', category: '网络路径追踪' },
  { prefix: 'tasklist', category: '进程列表查看' },
  { prefix: 'wmic', category: '系统 WMI 只读查询' },
  { prefix: 'pwd', category: '当前路径查看' },
  { prefix: 'dir', category: '目录列表查看' },
  { prefix: 'ls', category: '目录列表查看' },
  { prefix: 'Start-Sleep', category: '休眠等待' },
  { prefix: 'sleep', category: '休眠等待' },
];

// 3. Safe pipeline filters allowed after '|'
const SAFE_PIPELINE_TOOLS = [
  'select-object',
  'where-object',
  'measure-object',
  'select-string',
  'format-table',
  'format-list',
  'out-string',
  'findstr',
  'grep',
  'head',
  'tail',
  'sort-object',
  'sort',
  'more',
  'tee-object',
];

/**
 * HARDCODED TOKEN-LEVEL GIT VALIDATION
 * Strictly analyzes any command invocation starting with 'git' or 'git.exe'
 */
function validateGitCommandHardcoded(tokens: string[]): { allowed: boolean; category?: string; reason?: string } {
  // tokens[0] is 'git' or 'git.exe'
  let subVerbIndex = 1;

  // Skip global git options like: -C <path>, --git-dir=<path>, --work-tree=<path>, -c <key=val>, --no-pager
  while (subVerbIndex < tokens.length) {
    const t = tokens[subVerbIndex];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '-c') {
      subVerbIndex += 2; // skip option and its argument
    } else if (t.startsWith('-')) {
      subVerbIndex += 1;
    } else {
      break;
    }
  }

  if (subVerbIndex >= tokens.length) {
    return {
      allowed: true,
      category: 'Git 状态查看',
    };
  }

  const subVerb = tokens[subVerbIndex].toLowerCase();
  const restTokens = tokens.slice(subVerbIndex + 1);

  // 1. Check if subverb is in the strict read-only set
  if (!GIT_STRICT_READONLY_VERBS.has(subVerb)) {
    return {
      allowed: false,
      reason: `【Git硬编码安全拦截】检测到 Git 写入/修改类动词 "${subVerb}"。排障终端严格硬编码禁止执行任何 Git 暂存、提交、推送、合并、变基、分支创建/删除、代码检出或回滚操作。仅允许: ${Array.from(GIT_STRICT_READONLY_VERBS).join(', ')}。`,
    };
  }

  // 2. Specific checks for subverbs with potential modifying flags
  if (subVerb === 'branch') {
    const dangerousBranchFlags = ['-d', '-D', '-m', '-M', '--delete', '--move', '-c', '-C', '--copy'];
    if (restTokens.some((t) => dangerousBranchFlags.includes(t))) {
      return {
        allowed: false,
        reason: '【Git硬编码安全拦截】禁止通过 git branch 删除、重命名或创建分支。',
      };
    }
  }

  if (subVerb === 'tag') {
    // If tag has arguments without -l / --list, it might be creating or deleting a tag
    const isListOnly = restTokens.length === 0 || restTokens.includes('-l') || restTokens.includes('--list') || restTokens.includes('-n');
    if (!isListOnly || restTokens.includes('-d') || restTokens.includes('-a') || restTokens.includes('-s') || restTokens.includes('-f')) {
      return {
        allowed: false,
        reason: '【Git硬编码安全拦截】禁止通过 git tag 创建、删除或强推标签（仅允许只读列出已有标签）。',
      };
    }
  }

  if (subVerb === 'remote') {
    const dangerousRemoteVerbs = ['add', 'remove', 'rm', 'set-url', 'set-head', 'prune', 'update'];
    if (restTokens.some((t) => dangerousRemoteVerbs.includes(t.toLowerCase()))) {
      return {
        allowed: false,
        reason: '【Git硬编码安全拦截】禁止修改或增删 Git 远程仓库配置 (git remote)。',
      };
    }
  }

  const verbCategories: Record<string, string> = {
    status: 'Git 状态检查',
    log: 'Git 日志溯源',
    diff: 'Git 变更比对',
    show: 'Git 提交查阅',
    blame: 'Git 代码行作者溯源',
    branch: 'Git 分支只读列表',
    tag: 'Git 标签只读列表',
    'rev-parse': 'Git 引用解析',
    remote: 'Git 远端只读检查',
  };

  return {
    allowed: true,
    category: verbCategories[subVerb] || 'Git 只读查询',
  };
}

function isSingleCommandAllowed(cmd: string): { allowed: boolean; category?: string; reason?: string } {
  const trimmed = cmd.trim();
  if (!trimmed) return { allowed: false, reason: '命令不能为空' };

  // 1. Check blacklist first (highest priority rejection)
  for (const rule of BLACKLIST_RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `安全拦截: 命中了危险命令黑名单规则 [${rule.reason}]`,
      };
    }
  }

  // 2. Tokenize command
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { allowed: false, reason: '命令不能为空' };

  const firstToken = tokens[0].toLowerCase();

  // 3. HARDCODED GIT SAFETY GATE (still enforced for git commands)
  if (firstToken === 'git' || firstToken === 'git.exe') {
    return validateGitCommandHardcoded(tokens);
  }

  // 4. Check whitelist prefixes for category labeling (optional, not access control)
  let category = '排障指令';
  for (const item of WHITELIST_PREFIXES) {
    if (
      trimmed.toLowerCase() === item.prefix.toLowerCase() ||
      trimmed.toLowerCase().startsWith(item.prefix.toLowerCase() + ' ')
    ) {
      category = item.category;
      break;
    }
  }

  // 5. Default: allow (blacklist mode — only dangerous commands are blocked)
  return {
    allowed: true,
    category,
  };
}

export function validateCommandPolicy(fullCommand: string): CommandValidationResult {
  const trimmed = fullCommand.trim();
  if (!trimmed) {
    return { allowed: false, reason: '命令不能为空。' };
  }

  // 1. Check blacklist across full command line
  for (const rule of BLACKLIST_RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `安全拦截: 命中了危险命令黑名单规则 [${rule.reason}]`,
      };
    }
  }

  // 2. Split chained commands by semicolon or && or ||
  const chainedSubCmds = trimmed.split(/;|&&|\|\|/);
  if (chainedSubCmds.length > 1) {
    for (const sub of chainedSubCmds) {
      if (!sub.trim()) continue;
      const subRes = validateCommandPolicy(sub);
      if (!subRes.allowed) {
        return {
          allowed: false,
          reason: `链式命令安全拦截 (子命令 "${sub.trim()}"): ${subRes.reason}`,
        };
      }
    }
    return {
      allowed: true,
      category: '复合排障批处理命令',
    };
  }

  // 3. Check pipelines: e.g. "git log | Select-Object -First 5"
  const pipelineSegments = trimmed.split('|');
  const headCmd = pipelineSegments[0].trim();
  const headRes = isSingleCommandAllowed(headCmd);
  if (!headRes.allowed) {
    return headRes;
  }

  // If pipeline exists, check each downstream pipe command
  if (pipelineSegments.length > 1) {
    for (let i = 1; i < pipelineSegments.length; i++) {
      const pipeSegment = pipelineSegments[i].trim();
      const pipeToolName = pipeSegment.split(/\s+/)[0].toLowerCase();
      if (!SAFE_PIPELINE_TOOLS.includes(pipeToolName)) {
        return {
          allowed: false,
          reason: `管道安全拦截: 管道后置命令 "${pipeToolName}" 不属于安全的数据过滤工具列表。`,
        };
      }
    }
  }

  return headRes;
}
