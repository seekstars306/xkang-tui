import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The upstream model id may be overridden for a pinned provider route (e.g. a gateway-prefixed id); effort and output cap stay fixed.
export const MODEL_CANON = { model: process.env.EVAL_UPSTREAM_MODEL || 'deepseek-v4.1-flash', reasoning_effort: process.env.EVAL_UPSTREAM_REASONING_EFFORT || 'max', max_tokens: Number(process.env.EVAL_UPSTREAM_MAX_TOKENS || 128000) };
const dropped = ['temperature','top_p','presence_penalty','frequency_penalty','seed','max_completion_tokens','reasoning','thinking','top_k','n'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function normalizeModelRequest(body: Record<string, any>): Record<string, any> {
  const result = { ...body };
  for (const key of dropped) delete result[key];
  Object.assign(result, MODEL_CANON);
  if (result.stream) result.stream_options = { ...(result.stream_options || {}), include_usage: true };
  return result;
}
interface ProxyOptions { upstream: string; key: string; log: (record: Record<string, unknown>) => void; maxActive?: number; httpProxy?: string }
/** HTTPS upstream reached through a local HTTP CONNECT proxy (e.g. a gateway that is only reachable via the desktop proxy). */
function tunnelAgent(proxy: URL): https.Agent {
  const agent = new https.Agent({ keepAlive: false });
  (agent as any).createConnection = (opts: any, callback: (err: Error | null, socket?: any) => void) => {
    const connect = http.request({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: opts.host + ':' + (opts.port || 443) });
    connect.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); callback(new Error('PROXY_CONNECT_' + res.statusCode)); return; }
      callback(null, tls.connect({ socket, servername: opts.servername || opts.host }));
    });
    connect.once('error', err => callback(err));
    connect.end();
  };
  return agent;
}
interface QueueItem { runId: string; start: () => void; cancelled: () => boolean }
/** Global concurrency <=2, per-run <=1. Logs queue time separately; closes upstream on caller cancellation. */
export function createControlledProxy(options: ProxyOptions) {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') throw new Error('Only HTTP(S) upstreams are supported.');
  const transport = upstream.protocol === 'https:' ? https : http;
  const agent = upstream.protocol === 'https:' && options.httpProxy ? tunnelAgent(new URL(options.httpProxy)) : undefined;
  let active=0;
  const byRun=new Set<string>();
  const queue: QueueItem[]=[];
  const pump=()=>{
    while(active<(options.maxActive ?? 2)) {
      const idx=queue.findIndex(item=>item.cancelled() || !byRun.has(item.runId));
      if(idx<0)return;
      const item=queue.splice(idx,1)[0]; if(item.cancelled())continue;
      active++;byRun.add(item.runId);item.start();
    }
  };
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/health') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',canonical:MODEL_CANON,active,queued:queue.length,limits:{global:options.maxActive??2,perRun:1}}));return;}
    const route=/^\/run\/([A-Za-z0-9_-]{1,100})\/v1\/chat\/completions$/.exec(req.url || '');
    if(req.method!=='POST'||!route) {res.writeHead(404);res.end();return;}
    const runId=route[1],receivedAt=Date.now(),requestId=randomUUID();
    let finished=false,cancelled=false,started=false,up:http.ClientRequest|undefined;
    const record: Record<string,any>={requestId,runId,receivedAt:new Date(receivedAt).toISOString(),upstream:upstream.origin};
    const finish=(extra:Record<string,unknown>)=>{
      if(finished)return;finished=true;
      Object.assign(record,extra,{completedAt:new Date().toISOString(),wallMs:Date.now()-receivedAt});
      options.log(record);
      if(started){active--;byRun.delete(runId);}pump();
    };
    res.on('close',()=>{ if(res.writableFinished || finished)return; cancelled=true;up?.destroy();finish({clientAborted:true}); });
    try {
      const parts:Buffer[]=[];let bytes=0;
      for await(const c of req) {bytes+=c.length;if(bytes>50*1024*1024)throw new Error('body_too_large');parts.push(Buffer.from(c));}
      const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
      const normalized=normalizeModelRequest(body);
      record.original={model:body.model,effort:body.reasoning_effort,max_tokens:body.max_tokens,max_completion_tokens:body.max_completion_tokens,temperature:body.temperature,top_p:body.top_p};
      record.normalized=MODEL_CANON;
      record.requestHash=hash(normalized);record.messageHash=hash(normalized.messages);record.toolsHash=hash(normalized.tools || []);
      record.messageCount=normalized.messages?.length || 0;record.toolNames=(normalized.tools||[]).map((t:any)=>t.function?.name).filter(Boolean);
      record.promptChars=JSON.stringify(normalized.messages || []).length;
      record.responseFormat=normalized.response_format?.type || null;
      const outbound=Buffer.from(JSON.stringify(normalized));
      const start=()=>{
        started=true;const begun=Date.now();
        record.startedAt=new Date(begun).toISOString();record.queueMs=begun-receivedAt;record.activeAtStart=active;
        let pending='',nonStream='';
        const data=(s:string)=>{
          if(!s.startsWith('data:'))return;
          try {
            const chunk=JSON.parse(s.slice(5).trim());
            if(chunk.model)record.returnedModel=chunk.model;
            if(chunk.system_fingerprint)record.systemFingerprint=chunk.system_fingerprint;
            for(const ch of chunk.choices||[])if(ch.finish_reason)record.finishReason=ch.finish_reason;
            if(chunk.usage)record.usage=chunk.usage;
          } catch { /* done markers and non-data lines */ }
        };
        const baseHref=upstream.href.endsWith('/')?upstream.href:upstream.href+'/';
        // An origin-style upstream gets /v1/chat/completions; a base that already ends in /v1 only gets /chat/completions.
        up=(transport as typeof http).request(new URL(/\/v1\/$/.test(baseHref)?'chat/completions':'v1/chat/completions',baseHref),{
          method:'POST',agent,headers:{'content-type':'application/json','content-length':outbound.length,authorization:'Bearer '+options.key},
        },response=>{
          record.headersMs=Date.now()-begun;record.httpStatus=response.statusCode;
          res.writeHead(response.statusCode||502,{'content-type':response.headers['content-type'] || 'text/event-stream','cache-control':'no-store'});
          response.on('data',chunk=>{
            res.write(chunk);pending+=chunk.toString('utf8');
            if(normalized.stream){const lines=pending.split(/\r?\n/);pending=lines.pop()||'';for(const line of lines)data(line);}
            else if(nonStream.length<262144)nonStream+=chunk.toString('utf8');
          });
          response.on('end',()=>{
            data(pending);
            if(!normalized.stream) {try {const j=JSON.parse(nonStream);record.returnedModel=j.model;record.usage=j.usage;record.finishReason=j.choices?.[0]?.finish_reason;}catch{}}
            res.end();finish({streamMs:Date.now()-begun});
          });
          response.on('error',err=>{res.destroy();finish({upstreamErrorCode:(err as NodeJS.ErrnoException).code||'UPSTREAM_BODY_ERROR',streamMs:Date.now()-begun});});
        });
        up.on('error',err=>{
          if(!res.headersSent){res.writeHead(502);res.end(JSON.stringify({error:{message:'evaluation upstream transport error',type:'transport_error'}}));}else res.destroy();
          finish({upstreamErrorCode:(err as NodeJS.ErrnoException).code||'UPSTREAM_ERROR',streamMs:Date.now()-begun});
        });
        up.end(outbound);
      };
      queue.push({runId,start,cancelled:()=>cancelled});pump();
    } catch {
      if(!res.headersSent){res.writeHead(400);res.end(JSON.stringify({error:{message:'invalid evaluation proxy request'}}));}
      finish({proxyErrorCode:'INVALID_REQUEST'});
    }
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  // Key stays in memory only. 'magpie' reads the local gateway key; the default keeps the original server/.env behaviour.
  const source=process.env.EVAL_UPSTREAM_KEY_SOURCE || 'server-env';
  let key: string;
  if (source==='magpie') {
    const raw=fs.readFileSync(path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml'),'utf8');
    const m=raw.match(/MAGPIE_GATEWAY_KEY\s*[:=]\s*["']?([^"'\s]+)/);
    if(!m)throw new Error('gateway key not found');
    key=m[1];
  } else if (source==='gemini') key=dotenv.parse(fs.readFileSync('server/.env')).GEMINI_API_KEY;
  else if (source==='review') key=dotenv.parse(fs.readFileSync('server/.env')).REVIEW_MODEL_API_KEY;
  else if (source==='server-env') key=dotenv.parse(fs.readFileSync('server/.env')).DEEPSEEK_API_KEY;
  else throw new Error('Unknown evaluation key source');
  if (!key) throw new Error('Evaluation upstream key is missing');
  const upstream=process.env.EVAL_UPSTREAM_BASE || 'http://127.0.0.1:3065/';
  const port=Number(process.env.EVAL_PROXY_PORT || 3066);
  const out=process.env.EVAL_PROXY_LOG || 'eval_run/flow-v1-20261030/model-requests.jsonl';
  fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});
  const maxActive=Number(process.env.EVAL_PROXY_MAX_ACTIVE || 2);
  if(maxActive!==1&&maxActive!==2)throw new Error('EVAL_PROXY_MAX_ACTIVE must be 1 or 2');
  const httpProxy=process.env.EVAL_UPSTREAM_HTTP_PROXY || undefined;
  const server=createControlledProxy({upstream,key,maxActive,httpProxy,log:r=>fs.appendFileSync(out,JSON.stringify(r)+'\n')});
  server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port,upstream,keySource:source,httpProxy:httpProxy||null,canonical:MODEL_CANON,limits:{global:maxActive,perRun:1},log:out})));
}
