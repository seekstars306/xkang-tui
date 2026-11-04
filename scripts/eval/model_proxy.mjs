import http from 'node:http';
import fs from 'node:fs';
import dotenv from 'dotenv';
/**
 * 统一模型参数的记录代理：xkang / DSH / zcode 各连一个端口，全部转发到同一个 deepseek 接口。
 * 每个 chat/completions 请求都改写成同一套模型参数（模型、推理档位、输出上限、采样参数、密钥），
 * 并记录各家原本发出的参数与改写后的参数、提示词大小、返回的 token 用量——用证据保证"同一个模型配置"。
 * 工具定义、response_format 属于各家框架自身设计，不改。
 */
const env = dotenv.parse(fs.readFileSync('server/.env'));
const UPSTREAM = new URL('http://127.0.0.1:3065');
// 推理档位：2026-10-30 用户要求三家统一用 max
const CANON = { model: 'deepseek-v4.1-flash', reasoning_effort: process.env.PROXY_REASONING_EFFORT || 'max', max_tokens: 128000 };
const DROP = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'max_completion_tokens', 'reasoning', 'thinking', 'top_k', 'n'];
const PORTS = { 3066: 'xkang', 3067: 'dsh', 3068: 'zcode' };
fs.mkdirSync('D:/xk_cmp/proxy', { recursive: true });
const LOG = 'D:/xk_cmp/proxy/requests.jsonl';
const pickOrig = b => ({ model: b.model, reasoning_effort: b.reasoning_effort, reasoning: b.reasoning, thinking: b.thinking, max_tokens: b.max_tokens, max_completion_tokens: b.max_completion_tokens, temperature: b.temperature, top_p: b.top_p, stream: b.stream, response_format: b.response_format?.type, tools: Array.isArray(b.tools) ? b.tools.length : 0 });
for (const [port, harness] of Object.entries(PORTS)) {
  http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      let record = null;
      const startedAt = Date.now();
      if (req.method === 'POST' && /chat\/completions/.test(req.url || '')) {
        try {
          const b = JSON.parse(body.toString('utf8'));
          const orig = pickOrig(b);
          for (const k of DROP) delete b[k];
          Object.assign(b, CANON);
          if (b.stream) b.stream_options = { ...(b.stream_options || {}), include_usage: true };
          body = Buffer.from(JSON.stringify(b));
          record = { t: new Date().toISOString(), harness, orig, norm: { ...CANON, stream: b.stream, response_format: b.response_format?.type, tools: Array.isArray(b.tools) ? b.tools.length : 0 }, messages: (b.messages || []).length, promptChars: JSON.stringify(b.messages || []).length };
        } catch { record = { t: new Date().toISOString(), harness, parseError: true }; }
      }
      const headers = { ...req.headers, host: UPSTREAM.host, 'content-length': String(body.length), authorization: 'Bearer ' + env.DEEPSEEK_API_KEY };
      const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method, headers }, upRes => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        let tail = '';
        upRes.on('data', c => { res.write(c); if (record) { tail = (tail + c.toString('utf8')).slice(-65536); } });
        upRes.on('end', () => {
          res.end();
          if (record) {
            record.status = upRes.statusCode;
            record.ms = Date.now() - startedAt;
            const m = tail.match(/"usage"\s*:\s*(\{[^{}]*(\{[^{}]*\}[^{}]*)*\})/g);
            if (m) { try { const u = JSON.parse(m.at(-1).replace(/^"usage"\s*:\s*/, '')); record.usage = { prompt: u.prompt_tokens, completion: u.completion_tokens, reasoning: u.completion_tokens_details?.reasoning_tokens }; } catch {} }
            fs.appendFileSync(LOG, JSON.stringify(record) + '\n');
          }
        });
      });
      up.on('error', e => { if (record) fs.appendFileSync(LOG, JSON.stringify({ ...record, upstreamError: String(e.message) }) + '\n'); res.writeHead(502); res.end(String(e.message)); });
      up.end(body);
    });
  }).listen(Number(port), '127.0.0.1', () => console.log('proxy ' + harness + ' :' + port + ' -> ' + UPSTREAM.href));
}
