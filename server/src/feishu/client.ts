import * as lark from '@larksuiteoapi/node-sdk';
import https from 'node:https';
import { loadServerConfig } from '../config.js';

/**
 * 飞书长连接客户端。
 *
 * 用长连接而不是 Webhook：服务端只需要能访问公网，不需要公网 IP 或域名，
 * 也不用自己验签。官方限制：仅企业自建应用支持；同一应用多个客户端时消息随机投递给其中一个，
 * 所以这里不要同一个应用起第二个消费者（会和别的服务抢消息）。
 */

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export function getFeishuConfig(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export const MISSING_FEISHU_CONFIG =
  '未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，飞书接入未启用。在 server/.env 中补齐后重启即可。';

export interface BotIdentity {
  appName: string;
  openId: string;
  activateStatus: number;
}

/** 查询机器人自身信息，拿到 open_id 用于精确匹配结构化 @ */
export async function fetchBotIdentity(client: lark.Client): Promise<BotIdentity | null> {
  const res = await client.request<{ code?: number; bot?: { app_name?: string; open_id?: string; activate_status?: number } }>({
    method: 'GET',
    url: 'https://open.feishu.cn/open-apis/bot/v3/info',
  });
  const bot = res?.bot;
  if (!bot?.open_id) return null;
  return { appName: String(bot.app_name ?? ''), openId: String(bot.open_id), activateStatus: Number(bot.activate_status ?? -1) };
}

export interface FeishuClientBundle {
  client: lark.Client;
  ws: lark.WSClient;
  bot: BotIdentity;
}

/**
 * 建立长连接并注册消息事件。
 *
 * handler 必须快速返回：飞书要求 3 秒内响应，否则触发重推。
 * 因此这里只做去重和入队，真正的排查在队列里跑。
 */
export async function startFeishu(opts: {
  onMessage: (event: Record<string, unknown>) => void | Promise<void>;
  log?: (message: string) => void;
}): Promise<FeishuClientBundle | null> {
  const cfg = getFeishuConfig();
  if (!cfg) return null;

  const baseConfig = { appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: lark.LoggerLevel.warn };
  const client = new lark.Client(baseConfig);
  const bot = await fetchBotIdentity(client);
  if (!bot) throw new Error('无法获取机器人信息，请确认应用已启用机器人能力并已上线');

  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: Record<string, unknown>) => {
      // 注意：这里不要 await 整个排查流程，否则会超过 3 秒确认窗口
      try {
        await opts.onMessage(data);
      } catch (error) {
        opts.log?.(`处理飞书消息事件失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  // eventDispatcher 属于 start() 的参数，不是构造参数——放在这里 SDK 类型不接受，
  // 而且运行时也不会生效。只在 start 时传入即可。
  const ws = new lark.WSClient(baseConfig);
  await ws.start({ eventDispatcher: dispatcher });
  opts.log?.(`飞书长连接已建立：${bot.appName}（status=${bot.activateStatus}）`);
  return { client, ws, bot };
}

/** 取群历史一页（按时间降序）；调用方负责分页与截断 */
export async function listChatMessages(client: lark.Client, chatId: string, pageToken?: string, pageSize = 50) {
  const res = await client.request<{
    code?: number;
    msg?: string;
    data?: { items?: Array<Record<string, unknown>>; has_more?: boolean; page_token?: string; page_size?: number };
  }>({
    method: 'GET',
    url: 'https://open.feishu.cn/open-apis/im/v1/messages',
    params: {
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      page_size: pageSize,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  });
  if (res?.code !== 0 && res?.code !== undefined) throw new Error(`读取群历史失败：${res.msg ?? res.code}`);
  return res?.data ?? {};
}

/** 取单条消息（用于确认被引用的原消息存在且可见） */
export async function getMessage(client: lark.Client, messageId: string) {
  const res = await client.request<{ code?: number; msg?: string; data?: { items?: Array<Record<string, unknown>> } }>({
    method: 'GET',
    url: `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
  });
  const items = res?.data?.items ?? [];
  return items.find(item => item.message_id === messageId) ?? items[0] ?? null;
}

/**
 * 回复原消息并 @ 相关客服；uuid 用消息 ID 保证同一条 @ 不会重复回复。
 *
 * 支持多个 @：当原问题由 A 发出、而 B 来 @ 机器人时，两人都要被 @ 到——
 * B 是提出请求的人，A 是问题的当事人，只 @ B 会让 A 收不到结论。
 * 去重后按传入顺序排列，机器人自己会被跳过（@ 自己没有意义）。
 */
export async function replyToMessage(client: lark.Client, opts: {
  messageId: string;
  openIds: string[];
  text: string;
  idempotencyKey: string;
  /** 机器人自身 open_id，用于从 @ 列表里剔除 */
  botOpenId?: string;
}) {
  const seen = new Set<string>();
  const mentionIds = opts.openIds
    .filter(id => id && id !== opts.botOpenId)
    .filter(id => (seen.has(id) ? false : (seen.add(id), true)));
  const mentions = mentionIds.map(id => `<at user_id="${id}"></at>`).join(' ');
  const res = await client.request<{ code?: number; msg?: string; data?: { message_id?: string } }>({
    method: 'POST',
    url: `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(opts.messageId)}/reply`,
    data: { content: JSON.stringify({ text: `${mentions}${mentions ? ' ' : ''}${opts.text}` }), msg_type: 'text', uuid: opts.idempotencyKey.slice(0, 50) },
  });
  if (res?.code !== 0 && res?.code !== undefined) throw new Error(`回复消息失败：${res.msg ?? res.code}`);
  return res?.data?.message_id ?? null;
}

/**
 * 下载消息里的图片资源，转成 xkang 需要的 data URL。
 *
 * 不能用 client.request：SDK 那条路径按 JSON 解析响应，图片是二进制，
 * 拿回来不是 Buffer，之前因此一直返回 null（表现为“附件总是 0 个”）。
 * 这里直接走 https，并要求带上 tenant_access_token。
 */
export async function downloadImageAsDataUrl(client: lark.Client, messageId: string, fileKey: string): Promise<string | null> {
  const token = await getTenantToken();
  if (!token) return null;
  const url = new URL(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=image`);
  const result = await new Promise<{ status: number; contentType: string; body: Buffer } | null>((resolve) => {
    const req = https.request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        // 超过 10MB 直接放弃：模型侧也消化不了这么大的图
        if (size > 10 * 1024 * 1024) { req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
  if (!result || result.status !== 200) return null;
  // 上游返回 JSON 说明是错误响应（权限/资源不存在），不能当成图片塞给模型
  if (result.contentType.includes('application/json')) return null;
  const mime = result.contentType.split(';')[0] || 'image/png';
  return `data:${mime};base64,${result.body.toString('base64')}`;
}

/** 取应用身份 token；带进程内缓存，避免每张图都换一次 */
let cachedToken: { value: string; expiresAt: number } | null = null;
async function getTenantToken(): Promise<string | null> {
  const cfg = getFeishuConfig();
  if (!cfg) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.appId, client_secret: cfg.appSecret });
  const result = await new Promise<{ access_token?: string; expires_in?: number } | null>((resolve) => {
    const req = https.request('https://accounts.feishu.cn/oauth/v3/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000,
    }, res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(form.toString());
  });
  if (!result?.access_token) return null;
  cachedToken = { value: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 7200) * 1000 };
  return result.access_token;
}

export function createFeishuConfigHint(): string {
  const cfg = loadServerConfig();
  return cfg ? '' : MISSING_FEISHU_CONFIG;
}
