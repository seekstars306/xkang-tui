import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuDispatcher, type AgentRunner, type RunnerResult } from '../../server/src/feishu/dispatcher.ts';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';
import type { FeishuClientBundle } from '../../server/src/feishu/client.ts';

/**
 * 归属规则 0（dispatcher 级）：A 的问题还没出最终结果时，A 之后的任何一次 @ 都是对它的补充。
 *
 * 2026-10-29 事故：A 引用自己的问题 @ 机器人建了问题，还在跑时 A 不引用、直接 @ 说
 * "比较着急，我刚把状态手动改为未收款了"——被当成新问题，这句话成了【本次问题原文】，
 * 模型转去核实客服自己的操作。
 *
 * 要的行为：运行中收到的补充只排队，绝不另起一轮并行；这一轮结束时（结论、额度用完、报错都算）
 * 有排队的补充就不发这一轮的结果，在同一会话上带着全部排队补充接着跑补充轮，循环到没有新补充为止，
 * 全程只发最后一轮的那一条最终结论。这里用假飞书 + 假 runner 把整条链路跑一遍。
 */

// 导入 dispatcher 时 config.ts 会用 dotenv 把 server/.env 读进 process.env，这里把外呼条件全去掉：
//   TYPESAFE_API_KEY      → 意图 / 相关性判定走降级，不联网
//   FEISHU_APP_ID/SECRET  → 不换 token、不下载图片
//   XKANG_PUBLIC_BASE_URL → 不生成分享链接（那会写默认台账库）
for (const key of ['TYPESAFE_API_KEY', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'XKANG_PUBLIC_BASE_URL']) delete process.env[key];

const BOT = 'ou_bot';
const A = 'ou_A';
const B = 'ou_B';
const CHAT = 'oc_group_1';
const OTHER_CHAT = 'oc_group_2';
/** 场景起点（相当于 10:53:14），取在当前时间之前 */
const T0 = Date.now() - 20 * 60_000;
const at = (offsetMs: number) => T0 + offsetMs;
const QUESTION = '2359487636747 麻烦帮忙看一下这张票 没有收款记录 显示已收款';

interface ChatMessage {
  id: string;
  chat: string;
  sender: string;
  senderType: 'user' | 'app';
  at: number;
  text?: string;
  imageKey?: string;
  parentId?: string;
}

type Said = { id: string; sender: string; at: number; text?: string; imageKey?: string; parentId?: string; chat?: string };

/** 假飞书：群历史 / 单条消息 / 回复三个接口，回复按 uuid 去重（与飞书一致：同一个 uuid 只成功一次） */
class FakeFeishu {
  readonly messages: ChatMessage[] = [];
  readonly replies: Array<{ to: string; text: string; uuid: string; id: string }> = [];
  private readonly sentByUuid = new Map<string, string>();
  private seq = 0;
  readonly bundle = {
    client: { request: (opts: { method: string; url: string; params?: Record<string, unknown>; data?: Record<string, unknown> }) => this.request(opts) },
    ws: {},
    bot: { appName: '小康客服助手', openId: BOT, activateStatus: 0 },
  } as unknown as FeishuClientBundle;

  /** 群里有人说了一句（不 @ 机器人） */
  say(m: Said): void {
    this.messages.push({ chat: CHAT, senderType: 'user', ...m });
  }

  /** 有人 @ 了机器人：消息进群历史，同时返回飞书推过来的事件 */
  mention(m: Said): Record<string, unknown> {
    this.say(m);
    return {
      sender: { sender_id: { open_id: m.sender }, sender_type: 'user' },
      message: {
        message_id: m.id,
        chat_id: m.chat ?? CHAT,
        chat_type: 'group',
        create_time: String(m.at),
        message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 ${m.text ?? ''}`.trim() }),
        ...(m.parentId ? { parent_id: m.parentId, root_id: m.parentId } : {}),
        mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: '小康客服助手' }],
      },
    };
  }

  private item(m: ChatMessage): Record<string, unknown> {
    return {
      message_id: m.id,
      chat_id: m.chat,
      sender: m.senderType === 'app'
        ? { id: 'cli_bot', id_type: 'app_id', sender_type: 'app' }
        : { id: m.sender, id_type: 'open_id', sender_type: 'user' },
      create_time: String(m.at),
      msg_type: m.imageKey ? 'image' : 'text',
      body: { content: JSON.stringify(m.imageKey ? { image_key: m.imageKey } : { text: m.text ?? '' }) },
      ...(m.parentId ? { parent_id: m.parentId, root_id: m.parentId } : {}),
    };
  }

  private async request(opts: { method: string; url: string; params?: Record<string, unknown>; data?: Record<string, unknown> }) {
    await Promise.resolve(); // 和真接口一样异步返回
    const base = 'https://open.feishu.cn/open-apis/im/v1/messages';
    if (opts.method === 'GET' && opts.url === base) {
      const items = this.messages
        .filter(m => m.chat === opts.params?.container_id)
        .sort((x, y) => y.at - x.at)
        .map(m => this.item(m));
      return { code: 0, data: { items, has_more: false } };
    }
    const reply = opts.url.match(/\/messages\/([^/]+)\/reply$/);
    if (opts.method === 'POST' && reply) {
      const uuid = String(opts.data?.uuid ?? '');
      const existing = this.sentByUuid.get(uuid);
      if (existing) return { code: 0, data: { message_id: existing } };
      const to = decodeURIComponent(reply[1]);
      const raw = String((JSON.parse(String(opts.data?.content ?? '{}')) as { text?: string }).text ?? '');
      const id = `om_bot_${++this.seq}`;
      this.sentByUuid.set(uuid, id);
      this.replies.push({ to, text: raw.replace(/<at user_id="[^"]*"><\/at>\s*/g, ''), uuid, id });
      const chat = this.messages.find(x => x.id === to)?.chat ?? CHAT;
      this.messages.push({ id, chat, sender: BOT, senderType: 'app', at: Date.now(), text: raw, parentId: to });
      return { code: 0, data: { message_id: id } };
    }
    const one = opts.url.match(/\/messages\/([^/]+)$/);
    if (opts.method === 'GET' && one) {
      const m = this.messages.find(x => x.id === decodeURIComponent(one[1]));
      return { code: 0, data: { items: m ? [this.item(m)] : [] } };
    }
    throw new Error(`假飞书不认识的请求：${opts.method} ${opts.url}`);
  }
}

/**
 * 假 runner：记下每一轮收到的提示词和会话。
 * hold() 之后每一轮都卡住：release() 放行当前卡住的轮（之后的轮照样卡住），stopHolding() 全部放行。
 */
class FakeRunner implements AgentRunner {
  readonly calls: Array<{ issueId: string; text: string; sessionId: string | null }> = [];
  readonly resumed: string[] = [];
  /** 每次加预算续查收到的参数：content 是随续查带过去的排队补充（没带时为 null） */
  readonly resumeCalls: Array<{ sessionId: string; issueId: string; text: string | null; argCount: number }> = [];
  /** 第几次调用（从 1 起）返回"额度用完" */
  readonly frozenCalls = new Set<number>();
  /** 第几次调用（从 1 起）返回"没跑完"（没形成结论、但没冻结） */
  readonly incompleteCalls = new Set<number>();
  /** 第几次调用（从 1 起）抛错（带上会话，和真 runner 一样） */
  readonly failCalls = new Set<number>();
  /** 同一个问题同时在跑的轮数的最大值：必须始终是 1 */
  maxConcurrentPerIssue = 0;
  private readonly runningByIssue = new Map<string, number>();
  private holding = false;
  private waiting: Array<() => void> = [];

  hold(): void {
    this.holding = true;
  }

  release(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resume of waiting) resume();
  }

  stopHolding(): void {
    this.holding = false;
    this.release();
  }

  async run(input: Parameters<AgentRunner['run']>[0]): Promise<RunnerResult> {
    const n = this.calls.length + 1;
    const text = input.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
    this.calls.push({ issueId: input.issueId, text, sessionId: input.sessionId ?? null });
    const running = (this.runningByIssue.get(input.issueId) ?? 0) + 1;
    this.runningByIssue.set(input.issueId, running);
    this.maxConcurrentPerIssue = Math.max(this.maxConcurrentPerIssue, running);
    try {
      if (this.holding) await new Promise<void>(resolve => this.waiting.push(resolve));
      const sessionId = input.sessionId ?? `s_${input.issueId}_${n}`;
      if (this.failCalls.has(n)) throw Object.assign(new Error('模型请求失败：TLS 断开'), { sessionId });
      return {
        text: `【结论】第 ${n} 轮的结论\n\n问题编号 ${input.issueId}`,
        sessionId,
        frozen: this.frozenCalls.has(n),
        incomplete: this.incompleteCalls.has(n),
      };
    } finally {
      this.runningByIssue.set(input.issueId, (this.runningByIssue.get(input.issueId) ?? 1) - 1);
    }
  }

  async resume(...args: Parameters<NonNullable<AgentRunner['resume']>>): Promise<RunnerResult> {
    const [sessionId, issueId, content] = args;
    this.resumed.push(sessionId);
    this.resumeCalls.push({ sessionId, issueId, text: content ? content.map(p => (p.type === 'text' ? p.text : '')).join('\n') : null, argCount: args.length });
    return { text: `【结论】续查的结论\n\n问题编号 ${issueId}`, sessionId };
  }
}

async function until(what: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** 给 dispatcher 留出时间：如果它会（错误地）另起一轮，这段时间里就会起 */
const pause = () => new Promise(resolve => setTimeout(resolve, 60));

/** 取提示词里某一段（各段由 buildContent 以空行分隔的独立小标题开头） */
function section(text: string, header: string): string {
  const marker = `\n\n${header}\n\n`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n\n【[^】\n]+】\n\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function harness() {
  const dbPath = path.join(os.tmpdir(), `feishu-unfinished-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const monitor = new FeishuMonitorDb(dbPath);
  const feishu = new FakeFeishu();
  const runner = new FakeRunner();
  const logs: string[] = [];
  // 并发给够：这里要验的是归属与补充轮，不是排队
  const dispatcher = new FeishuDispatcher(feishu.bundle, runner, { monitor, maxConcurrent: 5, log: line => logs.push(line) });
  return {
    feishu, runner, monitor, dispatcher, logs,
    /** 群里收到的"结果"类回复：结论、额度用完、没跑完、报错 */
    results(): Array<{ to: string; text: string }> {
      return feishu.replies.filter(r => /【结论】|用完了预算|没有跑完|未能完成/.test(r.text));
    },
    /** 全部放行，等每一轮都收完尾 */
    async settle(): Promise<void> {
      runner.stopHolding();
      await until('全部任务收尾', () => monitor.listTasks({ limit: 100 }).every(t => t.status === 'done' || t.status === 'failed'));
      await new Promise(resolve => setTimeout(resolve, 20));
    },
    close(): void {
      monitor.close();
      fs.rmSync(dbPath, { force: true });
    },
  };
}

/** 10:53:14 A 发问题 + 截图；10:53:21 A 引用这条 @ 机器人 → 建问题并开跑（卡住不结束） */
async function startOriginal(h: ReturnType<typeof harness>): Promise<string> {
  h.runner.hold();
  h.feishu.say({ id: 'om_q', sender: A, at: at(0), text: QUESTION });
  h.feishu.say({ id: 'om_shot', sender: A, at: at(2_000), imageKey: 'img_shot' });
  await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at1', sender: A, at: at(7_000), parentId: 'om_q' }));
  await until('原问题开跑', () => h.runner.calls.length === 1);
  const first = h.runner.calls[0];
  assert.match(first.text, /请以它为准排查/);
  assert.match(section(first.text, '【本次问题原文】'), new RegExp(QUESTION));
  return first.issueId;
}

const mergedAck = (issueId: string) => `已收到补充信息（编号 ${issueId}），会并入当前排查`;

test('事故复现：A 的问题还在跑，A 不引用直接 @ 一句补充 → 只排队；原轮结束后不发结论，同一会话接着跑补充轮，只发一条最终结论', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);

    // 11:01:38 A 不引用任何消息，直接 @
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at2', sender: A, at: at(8 * 60_000 + 24_000), text: '比较着急，我刚把状态手动改为未收款了' }));
    await pause();
    assert.equal(h.runner.calls.length, 1, '原排查还在跑：补充只排队，不另起一轮');
    assert.ok(
      h.feishu.replies.some(r => r.to === 'om_at2' && r.text.includes(mergedAck(issueId))),
      '补充回执照常发，回在这次 @ 上并写明编号',
    );

    h.runner.release(); // 原问题这一轮结束
    await until('补充轮开跑', () => h.runner.calls.length === 2);
    assert.equal(h.results().length, 0, '有排队的补充：原轮的结论不发群里');
    const call = h.runner.calls[1];
    assert.equal(call.issueId, issueId, '并入原问题，不新建问题');
    assert.equal(call.sessionId, `s_${issueId}_1`, '在原问题的同一会话上接着跑');
    assert.doesNotMatch(call.text, /请以它为准排查/, '补充不能被当成新问题');
    assert.match(call.text, new RegExp(`客服补充了新的信息（问题编号 ${issueId}）`));
    const main = section(call.text, '【本次问题原文】');
    assert.match(main, new RegExp(QUESTION), '原问题仍是主问题');
    assert.doesNotMatch(main, /比较着急/, '补充的话不能混进问题原文');
    assert.match(section(call.text, '【客服补充】'), /比较着急，我刚把状态手动改为未收款了/);

    await h.settle();
    const results = h.results();
    assert.equal(results.length, 1, '全程只发一条最终结论');
    assert.match(results[0].text, /第 2 轮的结论/, '发的是补充轮的结论');
    assert.equal(h.runner.maxConcurrentPerIssue, 1, '同一问题从未并行');
    const tasks = h.monitor.listTasks({ limit: 100 });
    assert.deepEqual(tasks.map(t => t.id).sort(), [`${issueId}-1`, `${issueId}-2`], '台账里只有这一个问题的两轮');
    assert.ok(tasks.every(t => t.origin_message_id === 'om_q'), '两轮都挂在原问题上');
  } finally {
    h.close();
  }
});

test('运行中先后到两条补充（"继续"、带新的 19 位订单号）→ 原轮结束后只跑一轮补充，两条都在提示词里；只发一条结论、从无并行、不加预算', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);

    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_go', sender: A, at: at(3 * 60_000), text: '继续' }));
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_new_no', sender: A, at: at(4 * 60_000), text: '再帮我看下 1234567890123456789 这一单' }));
    await pause();
    assert.equal(h.runner.calls.length, 1, '原排查还在跑：两条补充都只排队');
    for (const trigger of ['om_go', 'om_new_no']) {
      assert.ok(
        h.feishu.replies.some(r => r.to === trigger && r.text.includes(mergedAck(issueId))),
        `${trigger} 要有写明编号的回执（飞书按 uuid 去重，第二条的回执不能被吞）`,
      );
    }

    await h.settle();
    assert.equal(h.runner.calls.length, 2, '原轮结束后只调用一次补充轮');
    const call = h.runner.calls[1];
    assert.equal(call.issueId, issueId);
    assert.equal(call.sessionId, `s_${issueId}_1`, '同一会话');
    const extra = section(call.text, '【客服补充】');
    assert.match(extra, /继续/);
    assert.match(extra, /1234567890123456789/);
    assert.ok(extra.indexOf('继续') < extra.indexOf('1234567890123456789'), '按到达顺序排列');
    const main = section(call.text, '【本次问题原文】');
    assert.match(main, new RegExp(QUESTION), '原问题仍是主问题');
    assert.doesNotMatch(main, /1234567890123456789/);

    const results = h.results();
    assert.equal(results.length, 1, '全程只发一条最终结论');
    assert.match(results[0].text, /第 2 轮的结论/);
    assert.equal(h.runner.maxConcurrentPerIssue, 1, '从未出现两个并行的 run');
    assert.equal(h.runner.resumed.length, 0, '"继续"在这里只是补充，不走加预算');
    assert.equal(h.monitor.getIssue('om_q')?.rounds, 1, '轮次不变');
  } finally {
    h.close();
  }
});

test('运行中 A 引用别人的一条消息再 @ → 排队并入，被引用的内容出现在补充轮的【客服补充】里', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);

    h.feishu.say({ id: 'om_b_note', sender: B, at: at(5 * 60_000), text: '财务那边显示流水号 8800112233 已到账' });
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at_quote', sender: A, at: at(6 * 60_000), parentId: 'om_b_note', text: '看下这条' }));
    await pause();
    assert.equal(h.runner.calls.length, 1, '引用了别的消息也一样只排队');
    assert.ok(h.feishu.replies.some(r => r.to === 'om_at_quote' && r.text.includes(mergedAck(issueId))));

    await h.settle();
    assert.equal(h.runner.calls.length, 2);
    const call = h.runner.calls[1];
    assert.equal(call.issueId, issueId);
    const extra = section(call.text, '【客服补充】');
    assert.match(extra, /看下这条/);
    assert.match(extra, /财务那边显示流水号 8800112233 已到账/, '被引用的那条（别人发的）要进补充材料');
    assert.ok(extra.indexOf('看下这条') < extra.indexOf('8800112233'), '被引用的那条紧跟在这次 @ 后面');
    assert.match(extra, /引用的消息/);
    const main = section(call.text, '【本次问题原文】');
    assert.match(main, new RegExp(QUESTION));
    assert.doesNotMatch(main, /8800112233/);
    assert.equal(h.results().length, 1);
  } finally {
    h.close();
  }
});

test('额度用完那种结束也算这一轮结束：有排队补充时不发"用完了预算"，同一会话接着跑补充轮（不加预算）', async () => {
  const h = harness();
  try {
    h.runner.frozenCalls.add(1);
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at2', sender: A, at: at(3 * 60_000), text: '补充：客户说昨天已经转账了' }));
    await h.settle();

    assert.equal(h.runner.calls.length, 2);
    assert.equal(h.runner.calls[1].sessionId, `s_${issueId}_1`, '同一会话');
    assert.match(section(h.runner.calls[1].text, '【客服补充】'), /客户说昨天已经转账了/);
    assert.ok(!h.feishu.replies.some(r => r.text.includes('用完了预算')), '额度用完的那一轮不发');
    const results = h.results();
    assert.equal(results.length, 1);
    assert.match(results[0].text, /第 2 轮的结论/);
    assert.equal(h.runner.resumed.length, 0, '补充轮走普通追问，不加预算');
  } finally {
    h.close();
  }
});

test('这一轮报错时有排队补充：报错不发，同一会话接着跑补充轮', async () => {
  const h = harness();
  try {
    h.runner.failCalls.add(1);
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at2', sender: A, at: at(3 * 60_000), text: '补充：截图里是 9 号的单子' }));
    await h.settle();

    assert.equal(h.runner.calls.length, 2);
    assert.equal(h.runner.calls[1].sessionId, `s_${issueId}_1`, '接着用报错那一轮的会话');
    assert.ok(!h.feishu.replies.some(r => /未能完成|没有跑完/.test(r.text)), '报错的那一轮不发');
    const results = h.results();
    assert.equal(results.length, 1);
    assert.match(results[0].text, /第 2 轮的结论/);
    const statuses = Object.fromEntries(h.monitor.listTasks({ limit: 100 }).map(t => [t.id, t.status]));
    assert.deepEqual(statuses, { [`${issueId}-1`]: 'failed', [`${issueId}-2`]: 'done' });
  } finally {
    h.close();
  }
});

test('补充轮跑的时候又来补充 → 再接一轮，直到没有新的排队补充，只发最后一轮的结论', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_s1', sender: A, at: at(3 * 60_000), text: '补充一：客户是线上付的款' }));
    h.runner.release(); // 原轮结束 → 补充轮开跑（仍卡住）
    await until('第一轮补充开跑', () => h.runner.calls.length === 2);

    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_s2', sender: A, at: at(5 * 60_000), text: '补充二：付款截图在上面' }));
    await pause();
    assert.equal(h.runner.calls.length, 2, '补充轮还在跑：新的补充同样只排队');
    h.runner.release();
    await until('第二轮补充开跑', () => h.runner.calls.length === 3);
    await h.settle();

    assert.match(section(h.runner.calls[1].text, '【客服补充】'), /补充一/);
    assert.doesNotMatch(section(h.runner.calls[1].text, '【客服补充】'), /补充二/);
    assert.match(section(h.runner.calls[2].text, '【客服补充】'), /补充二/);
    assert.equal(h.runner.calls[1].sessionId, `s_${issueId}_1`);
    assert.equal(h.runner.calls[2].sessionId, `s_${issueId}_1`, '始终是同一会话');
    const results = h.results();
    assert.equal(results.length, 1, '只发最后一轮');
    assert.match(results[0].text, /第 3 轮的结论/);
    assert.equal(h.runner.maxConcurrentPerIssue, 1);
  } finally {
    h.close();
  }
});

test('没有补充时与现有行为一致；出了最终结果之后，A 不引用 @ 一个新问题 → 新问题', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);
    await h.settle(); // 原问题回完结论
    assert.ok(h.feishu.replies.some(r => r.to === 'om_at1' && r.text.includes(`已开始排查（编号 ${issueId}）`)), '开始回执照旧');
    assert.deepEqual(h.results().map(r => r.to), ['om_at1'], '结论照旧回在触发的那次 @ 上，只有一条');
    assert.match(h.results()[0].text, /第 1 轮的结论/);

    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_next', sender: A, at: at(12 * 60_000), text: '另一个问题：9876543210123 这张票为什么出不了' }));
    await until('新问题开跑', () => h.runner.calls.length === 2);

    const call = h.runner.calls[1];
    assert.notEqual(call.issueId, issueId, '出了结果之后按原有规则：新问题');
    assert.match(call.text, /请以它为准排查/);
    assert.match(section(call.text, '【本次问题原文】'), /另一个问题：9876543210123 这张票为什么出不了/);
    assert.equal(section(call.text, '【客服补充】'), '');
    assert.ok(!h.feishu.replies.some(r => r.text.includes('已收到补充信息')));
    await h.settle();
  } finally {
    h.close();
  }
});

test('A 的问题还在跑时，B 的 @ 不会并入 A 的问题；A 在别的群里的 @ 也不会', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);

    // B 不引用直接 @ → B 自己的新问题
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_b_ask', sender: B, at: at(3 * 60_000), text: '帮我查一下 5555666677778888' }));
    await until('B 的问题开跑', () => h.runner.calls.length === 2);
    const ofB = h.runner.calls[1].issueId;
    assert.notEqual(ofB, issueId, 'B 的 @ 不能并入 A 的问题');
    // B 引用 A 的原问题再 @：照样不进 A 的问题——B 自己的问题还没出结果，按同一条规则排进 B 的
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_b_quote', sender: B, at: at(4 * 60_000), parentId: 'om_q', text: '我这边也是这样' }));
    assert.ok(h.feishu.replies.some(r => r.to === 'om_b_quote' && r.text.includes(mergedAck(ofB))));
    // A 在另一个群里 @ → 那个群里的新问题
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_a_other', sender: A, at: at(5 * 60_000), chat: OTHER_CHAT, text: '这个群里另一件事' }));
    await until('另一个群的问题开跑', () => h.runner.calls.length === 3);
    assert.notEqual(h.runner.calls[2].issueId, issueId, '跨群不并入');
    assert.match(h.runner.calls[2].text, /请以它为准排查/);

    await h.settle();
    assert.equal(h.runner.calls.filter(c => c.issueId === issueId).length, 1, 'A 的问题只有它自己那一轮');
    const bRounds = h.runner.calls.filter(c => c.issueId === ofB);
    assert.equal(bRounds.length, 2, 'B 的补充在 B 自己的问题上跑补充轮');
    assert.match(section(bRounds[1].text, '【客服补充】'), /我这边也是这样/);
    assert.ok(!h.feishu.replies.some(r => r.text.includes(mergedAck(issueId))), '没有任何一条被并入 A 的问题');
    assert.equal(h.runner.maxConcurrentPerIssue, 1);
  } finally {
    h.close();
  }
});

test('A 的两条 @ 几乎同时到达（上一条还没归属完）→ 后一条排进前一条建的问题，不会各成一个问题', async () => {
  const h = harness();
  try {
    h.runner.hold();
    h.feishu.say({ id: 'om_q', sender: A, at: at(0), text: QUESTION });
    // 飞书把积压的事件一口气推过来：第一条还在等网络时第二条就到了
    const first = h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at1', sender: A, at: at(7_000), parentId: 'om_q' }));
    const second = h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at2', sender: A, at: at(9_000), text: '截图里那个就是' }));
    await Promise.all([first, second]);
    await pause();
    assert.equal(h.runner.calls.length, 1, '后一条只排队，不另起问题');

    await h.settle();
    assert.equal(h.runner.calls.length, 2);
    assert.equal(h.runner.calls[1].issueId, h.runner.calls[0].issueId, '后一条并入前一条建的问题');
    assert.match(section(h.runner.calls[1].text, '【客服补充】'), /截图里那个就是/);
    assert.equal(h.results().length, 1);
  } finally {
    h.close();
  }
});


// ===== 运行中 @ 说"继续"：本轮没查完时下一轮追加 15 分钟续查 =====

const continueAck = (issueId: string) => `${mergedAck(issueId)}。您要求继续：本轮结束后如果还没查完，会再追加 15 分钟接着查。`;

test('运行中 @"继续"排队，本轮额度用完（frozen）→ 下一轮走加预算续查（resume），排队的补充在提示词里，只发一条最终结论', async () => {
  const h = harness();
  try {
    h.runner.frozenCalls.add(1);
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_go', sender: A, at: at(3 * 60_000), text: '继续' }));
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_extra', sender: A, at: at(4 * 60_000), text: '补充：客户说昨天已经转账了' }));
    await pause();
    assert.equal(h.runner.calls.length, 1, '运行中只排队');
    assert.ok(h.feishu.replies.some(r => r.to === 'om_go' && r.text.includes(continueAck(issueId))), '继续意图的回执写明编号和追加 15 分钟');
    assert.ok(h.feishu.replies.some(r => r.to === 'om_extra' && r.text.includes(mergedAck(issueId)) && !r.text.includes('追加')), '普通补充回执照旧');

    await h.settle();
    assert.equal(h.runner.calls.length, 1, '下一轮不是 runner.run');
    assert.equal(h.runner.resumeCalls.length, 1, '下一轮是 runner.resume（服务端 /continue）');
    const resumed = h.runner.resumeCalls[0];
    assert.equal(resumed.sessionId, `s_${issueId}_1`, '续的是原问题那一轮的会话');
    assert.equal(resumed.issueId, issueId);
    assert.ok(resumed.text, '排队的补充随续查一起带过去');
    assert.match(resumed.text!, new RegExp(`客服要求继续排查（问题编号 ${issueId}）`));
    const extra = section(resumed.text!, '【客服补充】');
    assert.match(extra, /继续/);
    assert.match(extra, /客户说昨天已经转账了/);
    assert.ok(!h.feishu.replies.some(r => r.text.includes('用完了预算')), '额度用完的那一轮不发');
    const results = h.results();
    assert.equal(results.length, 1, '只发一条最终结论');
    assert.match(results[0].text, /续查的结论/);
    assert.equal(h.monitor.getIssue('om_q')?.rounds, 2, '续查轮记一次轮次');
  } finally {
    h.close();
  }
});

test('运行中 @"继续"排队，本轮没跑完（incomplete）→ 同样走加预算续查', async () => {
  const h = harness();
  try {
    h.runner.incompleteCalls.add(1);
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_go', sender: A, at: at(3 * 60_000), text: '接着查' }));
    await h.settle();
    assert.equal(h.runner.calls.length, 1);
    assert.equal(h.runner.resumeCalls.length, 1);
    assert.equal(h.runner.resumeCalls[0].sessionId, `s_${issueId}_1`);
    assert.match(section(h.runner.resumeCalls[0].text ?? '', '【客服补充】'), /接着查/);
    assert.deepEqual(h.results().map(r => r.text.includes('续查的结论')), [true]);
  } finally {
    h.close();
  }
});

test('运行中 @"继续"排队，但本轮正常出了结论 → 下一轮照旧是普通补充轮（runner.run），不加预算', async () => {
  const h = harness();
  try {
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_go', sender: A, at: at(3 * 60_000), text: '继续' }));
    await h.settle();
    assert.equal(h.runner.calls.length, 2, '下一轮是 runner.run');
    assert.equal(h.runner.resumeCalls.length, 0, '查完了就不加预算');
    assert.equal(h.runner.calls[1].sessionId, `s_${issueId}_1`);
    assert.match(section(h.runner.calls[1].text, '【客服补充】'), /继续/);
    assert.equal(h.results().length, 1);
    assert.match(h.results()[0].text, /第 2 轮的结论/);
    assert.equal(h.monitor.getIssue('om_q')?.rounds, 1, '轮次不变');
  } finally {
    h.close();
  }
});

test('运行中排队的是普通补充（非继续），本轮额度用完 → 与改动前一致：普通补充轮（runner.run），回执不提追加', async () => {
  const h = harness();
  try {
    h.runner.frozenCalls.add(1);
    const issueId = await startOriginal(h);
    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_at2', sender: A, at: at(3 * 60_000), text: '客户手机号是 13800001111' }));
    await h.settle();
    assert.equal(h.runner.calls.length, 2);
    assert.equal(h.runner.resumeCalls.length, 0);
    assert.equal(h.runner.calls[1].sessionId, `s_${issueId}_1`);
    assert.match(section(h.runner.calls[1].text, '【客服补充】'), /13800001111/);
    const ack = h.feishu.replies.find(r => r.to === 'om_at2');
    assert.equal(ack?.text.trim(), `${mergedAck(issueId)}。`, '回执与改动前逐字一致');
    assert.equal(h.results().length, 1);
    assert.match(h.results()[0].text, /第 2 轮的结论/);
  } finally {
    h.close();
  }
});

test('原有路径：出了"额度用完"的最终结果后 @ 说继续 → 走 runner.resume（不带补充），回执写明追加 15 分钟', async () => {
  const h = harness();
  try {
    h.runner.frozenCalls.add(1);
    const issueId = await startOriginal(h);
    await h.settle();
    assert.equal(h.results().length, 1);
    assert.match(h.results()[0].text, /用完了预算/);

    await h.dispatcher.handleEvent(h.feishu.mention({ id: 'om_go_after', sender: A, at: at(16 * 60_000), text: '继续' }));
    await until('续查开始', () => h.runner.resumeCalls.length === 1);
    await h.settle();
    assert.equal(h.runner.calls.length, 1, '不走 runner.run');
    assert.equal(h.runner.resumeCalls[0].sessionId, `s_${issueId}_1`);
    assert.equal(h.runner.resumeCalls[0].text, null, '原有路径不带补充内容');
    assert.equal(h.runner.resumeCalls[0].argCount, 2, '调用形式与改动前一致');
    assert.ok(h.feishu.replies.some(r => r.to === 'om_go_after' && r.text.includes(`继续排查中（编号 ${issueId}），已追加 15 分钟`)));
    assert.match(h.results().at(-1)!.text, /续查的结论/);
  } finally {
    h.close();
  }
});
