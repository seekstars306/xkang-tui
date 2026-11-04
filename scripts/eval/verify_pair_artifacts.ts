import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readJson, canonicalJson } from './controlled_pair_helpers.js';
const batch=path.resolve(process.argv[2]),summary=readJson(path.join(batch,'all-summary.json'));
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const findings:any[]=[],runs:any[]=[];
for(const planned of summary.runs){
 const f=path.join(planned.dir,'run.json');if(!fs.existsSync(f))continue;const r=readJson(f);
 if(!['COMPLETED','COMPLETED_AFTER_DISCONNECT','SERVER_ERROR'].includes(r.status))continue;
 const original=fs.readFileSync(r.input.file),copied=fs.readFileSync(path.join(r.dir,'input.json'));
 const inputMatch=sha(original)===sha(copied)&&sha(original)===r.input.sha256;
 const publicFile=readJson(path.join(r.dir,'public.json'));
 const db=new DatabaseSync(path.join(r.dir,'data/xkang.db'),{readOnly:true});let stored:any;
 try{db.exec('PRAGMA query_only=ON; BEGIN');const row=db.prepare('SELECT public_json FROM agent_sessions WHERE id=?').get(r.timing.sessionId) as any;stored=row?JSON.parse(row.public_json):null;}finally{db.close();}
 const publicMatch=sha(canonicalJson(stored))===sha(canonicalJson(publicFile));
 const beforeAfterVersion=canonicalJson(r.version)===canonicalJson(r.finalVersion);
 const events=fs.readFileSync(path.join(r.dir,'events.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
 const answers=events.filter(e=>e.event?.type==='answer');const delivered=answers.at(-1)?.event.answer;
 const exportAnswer=publicFile?.turns?.at(-1)?.answer;
 const eventPublicMatch=delivered!==undefined&&sha(canonicalJson(delivered))===sha(canonicalJson(exportAnswer));
 const row={caseId:r.caseId,arm:r.arm,runId:r.runId,inputMatch,publicMatch,beforeAfterVersion,eventPublicMatch,answerEventCount:answers.length,doneEventCount:events.filter(e=>e.event?.type==='done').length,childStopped:r.childStopped,
  inputSha256:sha(copied),publicCanonicalSha256:sha(canonicalJson(publicFile)),publicDatabaseCanonicalSha256:sha(canonicalJson(stored))};
 runs.push(row);
 if(!inputMatch||!publicMatch||!beforeAfterVersion||r.childStopped!==true||(!eventPublicMatch&&r.terminalEvent==='done'))findings.push(row);
}
const result={at:new Date().toISOString(),batch:summary.batchId,verifiedRuns:runs.length,plannedRuns:summary.runs.length,valid:!findings.length,findings,runs,note:'Compare original inputs, stored public JSON, exported public JSON and the actual SSE answer; no business content or credentials are printed. Byte/canonical equality verifies export integrity, not answer truth.'};
fs.writeFileSync(path.join(batch,'artifact-integrity.json'),JSON.stringify(result,null,2)+String.fromCharCode(10));
console.log(JSON.stringify({verifiedRuns:runs.length,valid:result.valid,findings:findings.map(r=>({caseId:r.caseId,arm:r.arm,inputMatch:r.inputMatch,publicMatch:r.publicMatch,eventPublicMatch:r.eventPublicMatch,versionMatch:r.beforeAfterVersion,childStopped:r.childStopped}))},null,2));
if(findings.length)process.exitCode=1;
