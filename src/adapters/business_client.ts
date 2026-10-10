import type { PublicAnswer, PublicEvent, PublicQuestion, PublicSession } from '@xkang/agent-core/public';
import { getDeviceId } from '../utils/device.js';

function text(value: unknown): string { if (typeof value !== 'string') throw new Error('业务服务返回格式不兼容，请升级服务端。'); return value; }
export function publicAnswer(value: any): PublicAnswer {
  if (!['reviewed', 'needs_human', 'unreviewed'].includes(value?.reviewStatus)) throw new Error('业务回答未包含复核状态');
  return { conclusion: text(value.conclusion), businessData: value.businessData.map((item: any) => ({ label: text(item.label), value: text(item.value) })),
    evidenceSummary: value.evidenceSummary.map(text), customerReply: text(value.customerReply), pendingItems: value.pendingItems.map(text),
    reviewStatus: value.reviewStatus, traceId: text(value.traceId) };
}
function publicQuestion(value: any): PublicQuestion {
  return { id: text(value.id), questions: value.questions.map((q: any) => ({ question: text(q.question), ...(q.options ? { options: q.options.map((o: any) => ({ label: text(o.label), ...(o.description ? { description: text(o.description) } : {}) })) } : {}) })) };
}
export function publicSession(value: any): PublicSession {
  if (!['idle', 'running', 'waiting_question'].includes(value?.status)) throw new Error('业务服务版本不兼容');
  return { id: text(value.id), title: text(value.title), createdAt: text(value.createdAt), lastActiveAt: text(value.lastActiveAt), status: value.status,
    turns: value.turns.map((turn: any) => ({ id: text(turn.id), userText: text(turn.userText), ...(turn.answer ? { answer: publicAnswer(turn.answer) } : {}) })),
    ...(value.pendingQuestion ? { pendingQuestion: publicQuestion(value.pendingQuestion) } : {}) };
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
  async available(): Promise<boolean> {
    try { return (await this.request('/config/client')).businessApiVersion === 1; } catch { return false; }
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
  async chat(id: string, message: unknown, emit: (event: PublicEvent) => void): Promise<void> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/agent/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ message }) });
    if (!response.ok || !response.body) throw new Error('业务服务未接受本次请求，请稍后重试。');
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
}
