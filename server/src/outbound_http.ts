import http from 'node:http';
import tls from 'node:tls';
import type { Readable } from 'node:stream';

/**
 * 出站 HTTP 请求（可选走 HTTP 代理）。
 *
 * 为什么不用 undici 的 ProxyAgent：项目没有引入 undici，而 Node 内置 fetch 不接受 dispatcher。
 * 这里用 http.request(CONNECT) + tls.connect 手写隧道，只依赖 Node 内置模块。
 *
 * 行为约定：
 * - 未配置代理时，直接退化为全局 fetch，与引入本模块前完全一致（不改变任何现有调用）。
 * - 配置代理时，仅对 http(s) 请求建立隧道；CONNECT 失败会抛出带状态码的错误。
 */

export interface ProxyFetchOptions extends RequestInit {
  /** 单次请求总超时（毫秒），默认 60s */
  timeoutMs?: number;
}

function parseProxy(proxy: string): { host: string; port: number } {
  const u = new URL(proxy);
  if (u.protocol !== 'http:') throw new Error(`OUTBOUND_PROXY 仅支持 http://，当前：${proxy}`);
  return { host: u.hostname, port: Number(u.port || 80) };
}

/** 通过 HTTP 代理与目标建立 TLS 连接 */
function connectViaProxy(proxy: string, targetHost: string, targetPort: number, timeoutMs: number): Promise<tls.TLSSocket> {
  const p = parseProxy(proxy);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: p.host,
      port: p.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`代理 CONNECT 超时：${proxy}`)); }, timeoutMs);
    req.on('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败 ${res.statusCode}：${proxy}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => resolve(tlsSocket));
      tlsSocket.on('error', reject);
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

/** 把原始 HTTP 响应（含 chunked）解析成 Response */
async function toResponse(socket: tls.TLSSocket, method: string, path: string, headers: Record<string, string>, body: string | undefined): Promise<Response> {
  const payload = body ? Buffer.from(body) : null;
  const h: Record<string, string> = { ...headers, Connection: 'close' };
  if (payload) h['Content-Length'] = String(payload.length);
  let raw = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(h)) raw += `${k}: ${v}\r\n`;
  raw += '\r\n';
  socket.write(raw);
  if (payload) socket.write(payload);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on('data', (d: Buffer) => chunks.push(d));
    socket.on('end', () => resolve());
    socket.on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  const sep = text.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('代理响应格式异常：缺少头部终止符');
  const head = text.slice(0, sep).split('\r\n');
  const statusLine = head[0];
  const status = Number(statusLine.split(' ')[1] || 0);
  const respHeaders = new Headers();
  let chunked = false;
  for (const line of head.slice(1)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (/^transfer-encoding$/i.test(k) && /chunked/i.test(v)) chunked = true;
    // content-length 在解 chunked 后不再准确，交给 fetch 的 Response 自己算
    if (/^content-length$/i.test(k)) continue;
    respHeaders.set(k, v);
  }
  let payloadText = text.slice(sep + 4);
  if (chunked) {
    let out = '';
    let i = 0;
    while (i < payloadText.length) {
      const nl = payloadText.indexOf('\r\n', i);
      if (nl < 0) break;
      const size = parseInt(payloadText.slice(i, nl), 16);
      if (!size) break;
      out += payloadText.slice(nl + 2, nl + 2 + size);
      i = nl + 2 + size + 2;
    }
    payloadText = out;
  }
  return new Response(payloadText, { status, headers: respHeaders });
}

/**
 * 统一的出站请求入口。
 * @param proxy 形如 http://127.0.0.1:7897；为空时走直连 fetch
 */
export async function outboundFetch(url: string, options: ProxyFetchOptions = {}, proxy?: string): Promise<Response> {
  const { timeoutMs = 60000, ...init } = options;
  if (!proxy) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error(`走代理时仅支持 https:// 目标，当前：${url}`);
  const socket = await connectViaProxy(proxy, target.hostname, Number(target.port || 443), timeoutMs);
  try {
    const headers: Record<string, string> = { Host: target.hostname };
    // init.headers 可能是 Headers / 数组 / 普通对象；统一交给 Headers 归一化，
    // 这里不写 HeadersInit 类型，避免在未包含 DOM lib 的测试 tsconfig 下找不到该类型名。
    const rawHeaders = new Headers(init.headers as never);
    rawHeaders.forEach((v, k) => { headers[k] = v; });
    if (!headers['accept'] && !headers['Accept']) headers['Accept'] = 'application/json';
    const body = typeof init.body === 'string' ? init.body : undefined;
    return await toResponse(socket, (init.method || 'GET').toUpperCase(), target.pathname + target.search, headers, body);
  } finally {
    socket.destroy();
  }
}
