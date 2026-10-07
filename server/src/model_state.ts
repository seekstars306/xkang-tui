/**
 * 模型调度状态管理器 (基于 SQLite 集中存储)
 */
import { DatabaseSync } from 'node:sqlite';
import { ServerConfig } from './types.js';
import { AppDatabase } from './db.js';

export type ManagedModelId = 'auto' | 'deepseek' | 'gemini' | 'grok';
export type PromptTier = 'l1' | 'l2';
export type ModelTier = 'primary' | 'secondary' | 'fallback';

export interface ModelProfile {
  id: ManagedModelId;
  displayName: string;
  tier: ModelTier;
  promptTier: PromptTier;
  fallbackModel?: ManagedModelId;
  description: string;
}

export const ALL_MANAGED_MODELS: ManagedModelId[] = ['auto', 'gemini', 'deepseek', 'grok'];

export const MODEL_PROFILES: Record<ManagedModelId, ModelProfile> = {
  auto: {
    id: 'auto',
    displayName: 'Auto 智能动态路由 (日常 Grok Medium / 深度排障 Gemini)',
    tier: 'primary',
    promptTier: 'l2',
    fallbackModel: 'gemini',
    description: '智能双通道自动分流：日常文本/代码走 Grok Medium (L1)，遇到复杂排障/截图/对账纠错时自动升级为 Gemini (L2)。',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini Flash (自适应强推理)',
    tier: 'primary',
    promptTier: 'l2',
    fallbackModel: 'deepseek',
    description: '主选高智商推理模型，具备像素级 OCR 与全链路代码+数据库快速溯源能力，使用 L2 自适应提示词。',
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek (深度代码分析)',
    tier: 'secondary',
    promptTier: 'l2',
    fallbackModel: 'grok',
    description: '备选深度代码逻辑与 SQL 推理模型，具备较强代码语义理解，使用 L2 自适应提示词。',
  },
  grok: {
    id: 'grok',
    displayName: 'Grok 4.6 Medium (日常通用与任务编排)',
    tier: 'fallback',
    promptTier: 'l1',
    description: '日常通用与任务编排模型，具备出色的多步工具调度与格式执行精度，使用 L1 规范提示词管控。',
  },
};

export class ActiveModelManager {
  private db: DatabaseSync;
  private current: ManagedModelId;

  constructor(dbOrPath?: DatabaseSync | string, defaultModel?: string) {
    if (dbOrPath && typeof dbOrPath === 'object' && 'prepare' in dbOrPath) {
      this.db = dbOrPath;
    } else {
      this.db = AppDatabase.getInstance().db;
    }

    const fallback: ManagedModelId =
      defaultModel && ALL_MANAGED_MODELS.includes(defaultModel as ManagedModelId)
        ? (defaultModel as ManagedModelId)
        : 'auto';

    // 从 sys_configs 读取当前活跃模型
    const row = this.db.prepare(`SELECT value FROM sys_configs WHERE key = 'active_model'`).get() as any;
    if (row && ALL_MANAGED_MODELS.includes(row.value as ManagedModelId)) {
      this.current = row.value as ManagedModelId;
    } else {
      this.current = fallback;
      this.db.prepare(`
        INSERT OR REPLACE INTO sys_configs (key, value, updated_at)
        VALUES ('active_model', ?, datetime('now', 'localtime'))
      `).run(fallback);
    }
  }

  public getActive(): ManagedModelId {
    const row = this.db.prepare(`SELECT value FROM sys_configs WHERE key = 'active_model'`).get() as any;
    if (row && ALL_MANAGED_MODELS.includes(row.value as ManagedModelId)) {
      this.current = row.value as ManagedModelId;
    }
    return this.current;
  }

  public getActiveProfile(): ModelProfile {
    const active = this.getActive();
    return MODEL_PROFILES[active] || MODEL_PROFILES.auto;
  }

  public setActive(model: ManagedModelId): {
    previous: ManagedModelId;
    current: ManagedModelId;
    profile: ModelProfile;
  } {
    const previous = this.getActive();
    this.current = model;
    this.db.prepare(`
      INSERT OR REPLACE INTO sys_configs (key, value, updated_at)
      VALUES ('active_model', ?, datetime('now', 'localtime'))
    `).run(model);

    console.log(`[ActiveModelManager] 活跃模型已切换: [${previous}] -> [${model}]`);
    return {
      previous,
      current: model,
      profile: this.getActiveProfile(),
    };
  }

  public availableModels(config: ServerConfig): ManagedModelId[] {
    const available: ManagedModelId[] = [];
    if (config.mockLlm) return ALL_MANAGED_MODELS;
    if (config.deepseekApiKey) available.push('deepseek');
    if (config.geminiApiKey) available.push('gemini');
    if (config.grokApiKey) available.push('grok');
    if (available.length > 0) available.unshift('auto');
    return available;
  }
}

export interface ClassificationResult {
  targetModel: ManagedModelId;
  tier: PromptTier;
  matchedRule: string;
  reason: string;
}

export interface TierSwitchOptions {
  enableL1?: boolean;
  enableL2?: boolean;
}

/**
 * 智能双通道动态请求分类器：
 * - L1 (Grok Medium): 日常通用任务、本地文件读写/命令、基础问答、互联网搜索
 * - L2 (Gemini / DeepSeek): 内部代码排障、数据库/账单查证、图片多模态分析、客服争议投诉
 * 
 * 开关策略：
 * - ENABLE_L1=0, ENABLE_L2=1 -> 关闭 L1，全部走 L2 (Gemini)
 * - ENABLE_L1=1, ENABLE_L2=0 -> 关闭 L2，全部走 L1 (Grok)
 * - ENABLE_L1=1, ENABLE_L2=1 (默认) -> 启用智能动态路由
 */
export function classifyRequest(
  messages: any[],
  tools: any[] | undefined,
  activeSetting: ManagedModelId,
  tierOptions?: TierSwitchOptions
): ClassificationResult {
  const enableL1 = tierOptions?.enableL1 !== false;
  const enableL2 = tierOptions?.enableL2 !== false;

  // 1. 如果仅开启 L2（关闭 L1）：所有请求全量走 L2 (Gemini)
  if (!enableL1 && enableL2) {
    return {
      targetModel: 'gemini',
      tier: 'l2',
      matchedRule: 'L1_DISABLED_FORCE_L2',
      reason: '服务端环境配置已关闭 L1 (ENABLE_L1=0)，所有请求统一路由至 L2 (Gemini) 深度引擎',
    };
  }

  // 2. 如果仅开启 L1（关闭 L2）：所有请求全量走 L1 (Grok)
  if (enableL1 && !enableL2) {
    return {
      targetModel: 'grok',
      tier: 'l1',
      matchedRule: 'L2_DISABLED_FORCE_L1',
      reason: '服务端环境配置已关闭 L2 (ENABLE_L2=0)，所有请求统一路由至 L1 (Grok) 编排引擎',
    };
  }

  // 3. 如果两者均被关闭（异常兜底），默认走 L2 (Gemini)
  if (!enableL1 && !enableL2) {
    return {
      targetModel: 'gemini',
      tier: 'l2',
      matchedRule: 'ALL_TIERS_DISABLED_FALLBACK',
      reason: 'L1 与 L2 均被关闭，系统安全兜底路由至 L2 (Gemini)',
    };
  }

  // 4. 两者均开启（默认）：按智能动态规则分流
  // 规则 0：L1 通道主动声明能力不足（升级协议标记）-> 强制走 L2 (Gemini)
  // 只检测最后一条 user 消息：升级标记由 harness 注入的升级指令携带，仅对当次请求生效，
  // 避免历史中的标记把后续日常问题也永久路由到 L2
  const lastUserMsg = [...messages].reverse().find((m: any) => m?.role === 'user');
  const lastUserText = lastUserMsg
    ? typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg.content)
      ? lastUserMsg.content.map((c: any) => c.text || '').join(' ')
      : ''
    : '';
  if (lastUserText.includes('[[ESCALATE_TO_L2]]')) {
    return {
      targetModel: 'gemini',
      tier: 'l2',
      matchedRule: 'L1_ESCALATION',
      reason: 'L1 通道声明该请求需要内部数据深度排查，自动升级至 Gemini 深度排障引擎',
    };
  }

  // 如果管理员强制指定了固定模型（非 auto），直接走该模型
  if (activeSetting !== 'auto') {
    const profile = MODEL_PROFILES[activeSetting] || MODEL_PROFILES.gemini;
    return {
      targetModel: activeSetting,
      tier: profile.promptTier,
      matchedRule: `ADMIN_FIXED_SETTING (${activeSetting})`,
      reason: `管理员已将活跃模型锁定为 [${activeSetting}]`,
    };
  }

  // 1. 规则 1：检查是否包含图片多模态输入 -> 强制走 L2 (Gemini)
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const hasImage = m.content.some((p: any) => p.type === 'image_url' || p.image_url);
      if (hasImage) {
        return {
          targetModel: 'gemini',
          tier: 'l2',
          matchedRule: 'IMAGE_MULTIMODAL',
          reason: '检测到消息包含图片截图输入，路由至 Gemini 多模态强推理引擎',
        };
      }
    }
  }

  // 2. 规则 2：检查是否发起了内部企业代码或数据库查询工具 -> 强制走 L2 (Gemini)
  // 注意：跳过 harness 注入的【系统提醒】纠偏消息，以真实用户输入为准
  const lastMsg = [...messages].reverse().find((m: any) => {
    if (m?.role !== 'user') return false;
    const t = typeof m.content === 'string' ? m.content : '';
    return !t.startsWith('【系统提醒】');
  }) || messages[messages.length - 1];
  const userText = String(
    typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : Array.isArray(lastMsg?.content)
      ? lastMsg.content.map((c: any) => c.text || '').join(' ')
      : ''
  );

  const L2_KEYWORDS_REGEX = /(数据库|查库|sql|order|balance|hotel|refund|退款|流水|账单|报错|异常|trace|stacktrace|代码|controller|service|mapper|bug|崩溃|500|502|订单|单号|工单|支付|出票|退票|改签|退改|机票|火车票|航班|乘机|旅客|乘客|推送|转圈|用户|客户|商户|验证码|短信|下单|付款|收款|应收|实收|核销|入账|对账|结算|结账|充值|提现|转账|到账|未到账|收不到|不成功|扣款|手续费|服务费|发票|开票|报销|差额|行程|客票|票号|改期|航变|延误|取消|值机|座位|登机|行李|酒店|房型|预订|订房|门票|账号|金额|多少钱|差多少|系统|故障|payment|失败|搜不出|查不出|搜不到|查不到|不展示|出不来|白屏)/i;
  if (L2_KEYWORDS_REGEX.test(userText)) {
    return {
      targetModel: 'gemini',
      tier: 'l2',
      matchedRule: 'INTERNAL_TROUBLESHOOTING_KEYWORD',
      reason: '检测到内部业务对账、代码或异常排障关键字，升级至 Gemini 深度排障引擎',
    };
  }

  // 2.5 规则 2.5：携带业务单号（12-19位雪花ID/13位客票号/流水单号）或 11 位手机号的具体业务查询 -> 强制走 L2
  // L1 无深度排障查码查日志工具，误路由会导致模型只能反问或凭空编造
  const cleanDigits = userText.replace(/[\s.-]/g, '');
  if (/\d{12,19}/.test(cleanDigits) || /1[3-9]\d{9}/.test(userText) || /\b\d{3}-\d{10}\b/.test(userText)) {
    return {
      targetModel: 'gemini',
      tier: 'l2',
      matchedRule: 'BUSINESS_ID_DETECTED',
      reason: '检测到客票号/订单号/流水单号/手机号等业务标识，需查库核验，升级至 Gemini 深度排障引擎',
    };
  }

  // 3. 默认日常通用任务 -> 路由至 Grok 4.6 Medium (L1)
  return {
    targetModel: 'grok',
    tier: 'l1',
    matchedRule: 'GENERAL_TASK_DEFAULT',
    reason: '日常通用文本/文件/检索任务，分流至 Grok 4.6 Medium 高效编排引擎',
  };
}

