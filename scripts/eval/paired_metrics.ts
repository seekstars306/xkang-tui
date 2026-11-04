import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson } from './controlled_pair_helpers.js';
const batch=path.resolve(process.argv[2]);
const summary=readJson(path.join(batch,'all-summary.json'));
const log=path.join(path.dirname(batch),'model-requests.jsonl');
const proxy=fs.existsSync(log)?fs.readFileSync(log,'utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)):[];
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const median=(v:number[])=>{const a=[...v].sort((a,b)=>a-b);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
const rows=summary.runs.map((r:any)=>{
  const runFile=path.join(r.dir,'run.json');const run=fs.existsSync(runFile)?readJson(runFile):r;
  const auditFile=path.join(r.dir,'audit.json');const audit=fs.existsSync(auditFile)?readJson(auditFile)||[]:[];
  const privateFile=path.join(r.dir,'private.json');const p=fs.existsSync(privateFile)?readJson(privateFile):null;
  const calls=proxy.filter(q=>q.runId===r.runId);
  const model=audit.filter((a:any)=>a.type==='llm_chat');const tools=audit.filter((a:any)=>a.type==='tool_call');
  const details=(a:any)=>{try{return typeof a.details==='string'?JSON.parse(a.details):a.details||{}}catch{return{}}};
  const time=run.timing||{};
  const tokenTotal=(key:string)=>model.reduce((n:number,a:any)=>n+(Number(a[key])||0),0);
  const counts:Record<string,number>={};for(const t of tools)counts[t.tool_name]=(counts[t.tool_name]||0)+1;
  const errors=model.filter((a:any)=>!a.success).map((a:any)=>({errorCode:details(a).errorCode||'LEGACY_UNCLASSIFIED',purpose:details(a).purpose,finishReason:details(a).finishReason,durationMs:a.duration_ms}));
  const candidateTexts=(p?.messages||[]).filter((m:any)=>m.role==='assistant'&&!m.tool_calls?.length&&m.content).length;
  return {caseId:r.caseId,arm:r.arm,status:run.status,
    answerPresent:run.answerPresent??null,delivery:time.delivery,frozen:time.frozen,infraErrors:time.errors,
    questionToDoneMs:time.completedAt&&time.questionSentAt?Date.parse(time.completedAt)-Date.parse(time.questionSentAt):null,spawnToDoneMs:time.wallMs,
    auditModelCalls:model.length,modelErrors:errors,auditToolCalls:tools.length,failedTools:tools.filter((a:any)=>!a.success).length,toolCounts:counts,
    proxyObservedCalls:calls.length,proxyCancelled:calls.filter(q=>q.clientAborted).length,httpErrors:calls.filter(q=>q.httpStatus>=400).map(q=>q.httpStatus),
    queueMs:calls.reduce((n,q)=>n+(q.queueMs??(!q.startedAt&&q.clientAborted?q.wallMs:0)??0),0),queueMsRecoveredFromCancelled:calls.filter(q=>q.queueMs===undefined&&!q.startedAt&&q.clientAborted).reduce((n,q)=>n+(q.wallMs||0),0),proxyStreamMs:calls.reduce((n,q)=>n+(q.streamMs||0),0),
    requestedModels:[...new Set(calls.map(q=>q.normalized?.model))],returnedModels:[...new Set(calls.map(q=>q.returnedModel).filter(Boolean))],
    outputLimits:[...new Set(calls.map(q=>q.normalized?.max_tokens))],efforts:[...new Set(calls.map(q=>q.normalized?.reasoning_effort))],
    finishReasons:calls.reduce((a,q)=>{const k=q.finishReason||'MISSING';a[k]=(a[k]||0)+1;return a;},{}),
    tokens:{prompt:tokenTotal('prompt_tokens'),completion:tokenTotal('completion_tokens'),total:tokenTotal('total_tokens')},
    candidateTexts,caseEvidenceCalls:(p?.messages||[]).filter((m:any)=>m.role==='tool'&&m.name==='check_case_evidence').length,
    artifactHashes:Object.fromEntries(['public.json','private.json','audit.json','timing.json','run.json'].filter(f=>fs.existsSync(path.join(r.dir,f))).map(f=>[f,hash(fs.readFileSync(path.join(r.dir,f)))]))};
});
const terminalStatuses=new Set(['COMPLETED','COMPLETED_AFTER_DISCONNECT','SERVER_ERROR','INFRA_INTERRUPTED','NOT_STARTED_INFRA']);
const completed=rows.filter((r:any)=>terminalStatuses.has(r.status));
const infrastructureFailures=completed.filter((r:any)=>['INFRA_INTERRUPTED','NOT_STARTED_INFRA'].includes(r.status));
const investigationTerminated=completed.filter((r:any)=>!['INFRA_INTERRUPTED','NOT_STARTED_INFRA'].includes(r.status));
const byArm=Object.fromEntries(['baseline','candidate'].map(arm=>{const a=investigationTerminated.filter((r:any)=>r.arm===arm);return [arm,{runs:a.length,infrastructureFailures:infrastructureFailures.filter((r:any)=>r.arm===arm).length,medianQuestionMs:median(a.map((r:any)=>r.questionToDoneMs).filter((n:any)=>n!==null)),totalTokens:a.reduce((n:number,r:any)=>n+r.tokens.total,0),modelErrors:a.reduce((n:number,r:any)=>n+r.modelErrors.length,0),caseEvidenceCalls:a.reduce((n:number,r:any)=>n+r.caseEvidenceCalls,0)}];}));
const result={createdAt:new Date().toISOString(),batch:summary.batchId,sourceControls:summary.controls,completedRuns:completed.length,investigationTerminated:investigationTerminated.length,infrastructureFailures:infrastructureFailures.length,plannedRuns:rows.length,byArm,rows,notes:['No quality grading is inferred from a non-empty answer or HTTP 200.','Legacy and candidate audit rows include different attempt visibility; proxy HTTP records are shared observation.','Cancelled upstream streams may have no usage; token counts are observed lower bounds, not money cost.','Input, source/graph hashes are frozen; business DB/log data are live read-only.']};
fs.writeFileSync(path.join(batch,'metrics.json'),JSON.stringify(result,null,2)+String.fromCharCode(10));
console.log(JSON.stringify({completedRuns:completed.length,plannedRuns:rows.length,byArm,completed:completed.map((r:any)=>({caseId:r.caseId,arm:r.arm,delivery:r.delivery,status:r.status,ms:r.questionToDoneMs,modelErrors:r.modelErrors.length,caseEvidenceCalls:r.caseEvidenceCalls}))},null,2));
