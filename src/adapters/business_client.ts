import type { PublicAnswer, PublicEvent, PublicQuestion, PublicSession } from '@xkang/agent-core/public';
import { getDeviceId } from '../utils/device.js';

function text(value: unknown): string { if (typeof value !== 'string') throw new Error('业务服务返回格式不兼容，请升级服务端。'); return value; }
/** R1：claims 为可选字段——服务端未开启部分发布时不下发，客户端适配器不得静默丢弃 */
function publicClaims(value: any): PublicAnswer['claims'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons = ['challenged', 'unsupported', 'citation_unverified'];
  return value.map((claim: any) => ({
    text: text(claim.text),
    status: claim.status === 'confirmed' ? 'confirmed' as const : 'pending' as const,
    ...(Array.isArray(claim.conditions) ? { conditions: claim.conditions.map(text) } : {}),
    ...(Array.isArray(claim.exceptions) ? { exceptions: claim.exceptions.map(text) } : {}),
    ...(Array.isArray(claim.evidenceRefs) ? { evidenceRefs: claim.evidenceRefs.map(text) } : {}),
    // R1：未核实原因按白名单透传；未知值直接丢弃，绝不让新增字段把整篇答案变成"格式不兼容"
    ...(typeof claim.reason === 'string' && reasons.includes(claim.reason) ? { reason: claim.reason } : {}),
  }));
}
export function publicAnswer(value: any): PublicAnswer {
  if (!['reviewed', 'needs_human', 'unreviewed'].includes(value?.reviewStatus)) throw new Error('业务回答未包含复核状态');
  const claims = publicClaims(value.claims);
  return { conclusion: text(value.conclusion), businessData: value.businessData.map((item: any) => ({ label: text(item.label), value: text(item.value) })),
    evidenceSummary: value.evidenceSummary.map(text), customerReply: text(value.customerReply), pendingItems: value.pendingItems.map(text),
    reviewStatus: value.reviewStatus, traceId: text(value.traceId), ...(claims ? { claims } : {}) };
}
function publicQuestion(value: any): PublicQuestion {
  return { id: text(value.id), questions: value.questions.map((q: any) => ({ question: text(q.question), ...(q.options ? { options: q.options.map((o: any) => ({ label: text(o.label), ...(o.description ? { description: text(o.description) } : {}) })) } : {}) })) };
}
export function publicSession(value: any): PublicSession {
  if (!['idle', 'running', 'waiting_question'].includes(value?.status)) throw new Error('业务服务版本不兼容');
  return { id: text(value.id), title: text(value.title), createdAt: text(value.createdAt), lastActiveAt: text(value.lastActiveAt), status: value.status,
    turns: value.turns.map((turn: any) => ({ id: text(turn.id), userText: text(turn.userText), ...(turn.answer ? { answer: publicAnswer(turn.answer) } : {}) })),
    ...(value.pendingQuestion ? { pendingQuestion: publicQuestion(value.pendingQuestion) } : {}),
    // R2 冻结字段透传（线缆 status 仍只有三个枚举值）
    ...(typeof value.frozen === 'boolean' ? { frozen: value.frozen } : {}),
    ...(Number.isInteger(value.extensions) ? { extensions: value.extensions } : {}),
    ...(Number.isInteger(value.activeElapsedMs) ? { activeElapsedMs: value.activeElapsedMs } : {}),
    ...(Number.isInteger(value.activeBudgetMs) ? { activeBudgetMs: value.activeBudgetMs } : {}) };
}
export class BusinessClient {
  constructor(private url: string, private token: string) {}
  private headers() { return { Authorization: `Bearer ${this.token}`, 'x-device-id': getDeviceId(), 'Content-Type': 'application/json' }; }
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    let response: Response;
    try { response = await fetch(`${this.url.replace(/\/$/, '')}${path}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('业务服务暂时无法连接，请稍后重试。'); }
    if (!response.ok) throw new Error(response.status === 409 ? '当前会话正在处理，或历史迁移尚未完成。' : response.status === 401 || response.status === 403 ? '身份验证未通过，请检查员工授权。' : '业务服务未完成请求，请检查服务端版本或稍后重试。');
    return response.json();
  }
  /** 服务端能力协商：特性开关（如 R2 timeBudget、R1 partialPublish）由 /config/client 下发；连不上时按未开启处理 */
  async config(): Promise<{ businessApiVersion?: number; features?: Record<string, boolean> }> {
    try { return await this.request('/config/client'); } catch { return {}; }
  }
  async create(): Promise<PublicSession> { return publicSession(await this.request('/agent/sessions', 'POST', {})); }
  async list(): Promise<PublicSession[]> { return (await this.request('/agent/sessions')).map(publicSession); }
  async get(id: string): Promise<PublicSession> { return publicSession(await this.request(`/agent/sessions/${encodeURIComponent(id)}`)); }
  async delete(id: string) { await this.request(`/agent/sessions/${encodeURIComponent(id)}`, 'DELETE'); }
  async answer(id: string, qid: string, answer: string) { await this.request(`/agent/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(qid)}/answer`, 'POST', { answer }); }
  async migrate(migrationId: string, hash: string, source: unknown): Promise<{ hash: string; session: PublicSession }> {
    const response = await this.request('/agent/migrations', 'POST', { migrationId, hash, source });
    if (response.hash !== hash) throw new Error('迁移校验未通过，原会话未清理。');
    return { hash, session: publicSession(response.session) };
  }
  /** 按公开事件协议解析 SSE 帧（messages 与 continue 两条流共用） */
  private async stream(response: Response, emit: (event: PublicEvent) => void): Promise<void> {
    if (!response.body) throw new Error('业务服务未返回数据流，请稍后重试。');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
          const event = JSON.parse(data.slice(6));
          if (event.type === 'progress' && ['checking', 'reviewing', 'revising'].includes(event.phase)) emit({ type: 'progress', phase: event.phase });
          else if (event.type === 'answer') emit({ type: 'answer', turnId: text(event.turnId), answer: publicAnswer(event.answer) });
          else if (event.type === 'question') emit({ type: 'question', question: publicQuestion(event.question) });
          else if (event.type === 'error') emit({ type: 'error', message: '本次业务请求未完成，请稍后重试。', traceId: text(event.traceId) });
          else if (event.type === 'done') emit({ type: 'done' });
        }
      }
    } finally { reader.releaseLock(); }
  }
  async chat(id: string, message: unknown, emit: (event: PublicEvent) => void): Promise<void> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/agent/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ message }) });
    if (!response.ok || !response.body) throw new Error('业务服务未接受本次请求，请稍后重试。');
    await this.stream(response, emit);
  }
  /** R2：续查。对已冻结会话追加 15 分钟活跃预算并恢复运行（服务端重复点击幂等） */
  async continue(id: string, emit: (event: PublicEvent) => void): Promise<void> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/agent/sessions/${encodeURIComponent(id)}/continue`, { method: 'POST', headers: this.headers() });
    if (!response.ok || !response.body) throw new Error(response.status === 409 ? '这个会话没有到 15 分钟上限，无需续查。' : response.status === 404 ? '会话不存在或已结束，请刷新后重试。' : '业务服务未接受续查请求，请稍后重试。');
    await this.stream(response, emit);
  }
}
