import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './controlled_pair_helpers.js';
const batch=path.resolve(process.argv[2]),summary=readJson(path.join(batch,'all-summary.json'));
const runIds=new Set(summary.runs.map((r:any)=>r.runId));
const logfile=path.join(path.dirname(batch),'model-requests.jsonl');
const lines=fs.readFileSync(logfile,'utf8').split(/\r?\n/).filter(Boolean);
const requests=lines.map(l=>JSON.parse(l)).filter(r=>runIds.has(r.runId));
const failures:any[]=[];
for(const r of requests){if(r.normalized?.model!=='deepseek-v4.1-flash'||r.normalized?.reasoning_effort!=='max'||r.normalized?.max_tokens!==128000)failures.push({runId:r.runId,requestId:r.requestId,code:'NORMALIZED_PARAMETER_MISMATCH'});}
const events:any[]=[];
for(const r of requests){if(!r.startedAt)continue;events.push({t:Date.parse(r.startedAt),start:1,runId:r.runId,id:r.requestId});events.push({t:Date.parse(r.completedAt),start:0,runId:r.runId,id:r.requestId});}
events.sort((a,b)=>a.t-b.t||a.start-b.start);
let active=0,maxActive=0;const byRun=new Map<string,number>();let maxPerRun=0;
for(const e of events){active+=e.start?1:-1;maxActive=Math.max(maxActive,active);byRun.set(e.runId,(byRun.get(e.runId)||0)+(e.start?1:-1));maxPerRun=Math.max(maxPerRun,byRun.get(e.runId)!);}
if(maxActive>2||maxPerRun>1)failures.push({code:'OBSERVED_CONCURRENCY_EXCEEDED',maxActive,maxPerRun});
const byArm=Object.fromEntries(['baseline','candidate'].map(arm=>{
 const ids=new Set(summary.runs.filter((r:any)=>r.arm===arm).map((r:any)=>r.runId));const a=requests.filter(r=>ids.has(r.runId));
 const knownHeaders=a.filter(r=>typeof r.headersMs==='number').map(r=>r.headersMs).sort((a,b)=>a-b);
 const p=(x:number)=>knownHeaders.length?knownHeaders[Math.min(knownHeaders.length-1,Math.floor((knownHeaders.length-1)*x))]:null;
 return [arm,{requestCount:a.length,started:a.filter(r=>r.startedAt).length,cancelledBeforeStart:a.filter(r=>r.clientAborted&&!r.startedAt).length,cancelledAfterStart:a.filter(r=>r.clientAborted&&r.startedAt).length,finishedNormally:a.filter(r=>!r.clientAborted&&!r.upstreamErrorCode&&!r.proxyErrorCode).length,httpStatusCodes:[...new Set(a.map(r=>r.httpStatus??null))],headersMs:{p50:p(.5),p90:p(.9),max:knownHeaders.at(-1)??null},queueMsSum:a.reduce((n,r)=>n+(r.queueMs??(!r.startedAt&&r.clientAborted?r.wallMs:0)??0),0),queueMsRecoveredFromCancelled:a.filter(r=>r.queueMs===undefined&&!r.startedAt&&r.clientAborted).reduce((n,r)=>n+(r.wallMs||0),0),returnedModels:[...new Set(a.map(r=>r.returnedModel).filter(Boolean))],responseFormats:[...new Set(a.map(r=>r.responseFormat))]}];
}));
const result={at:new Date().toISOString(),batch:summary.batchId,requestCount:requests.length,valid:failures.length===0,failures,observedClosedRequestConcurrency:{maxActive,maxPerRun},byArm,
qualification:['These are completed/cancelled request records, not hidden provider internals. Any currently active requests are not yet recorded.','A cancellation may still be in TCP teardown when the next request starts; limits describe proxy admission, not upstream completion semantics.','Request model alias is pinned, returned name is observed; hidden weights/provider version are not independently attested.','Headers latency excludes proxy queue; timed-out/cancelled calls without headers are right-censored, not fast successful responses.']};
fs.writeFileSync(path.join(batch,'request-controls.json'),JSON.stringify(result,null,2)+String.fromCharCode(10));
console.log(JSON.stringify(result,null,2));if(failures.length)process.exitCode=1;
