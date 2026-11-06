import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJson } from './controlled_pair_helpers.js';
const batch=path.resolve(process.argv[2]);
const summary=readJson(path.join(batch,'all-summary.json'));
const result=[];
for(const r of summary.runs) {
  const runFile=path.join(r.dir,'run.json');const current=fs.existsSync(runFile)?readJson(runFile):r;
  const dbPath=path.join(r.dir,'data/xkang.db');let inspection:any;
  if(fs.existsSync(dbPath)) {
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try {
      const audits=db.prepare('SELECT type, success, details, tool_name, duration_ms FROM audit_logs ORDER BY id').all() as any[];
      const llm=audits.filter(a=>a.type==='llm_chat');
      const tool=audits.filter(a=>a.type==='tool_call');
      const names:Record<string,number>={};for(const t of tool)names[t.tool_name]=(names[t.tool_name]||0)+1;
      const raw=db.prepare('SELECT public_json,private_json FROM agent_sessions ORDER BY updated_at DESC LIMIT 1').get() as any;
      const p=raw?JSON.parse(raw.public_json):null;
      const history=raw?JSON.parse(raw.private_json):[];
      const checks=history.filter((m:any)=>m.role==='tool'&&m.name==='check_case_evidence');
      inspection={sessionStatus:p?.status,turns:p?.turns?.length,publicDelivery:p?.turns?.at(-1)?.answer?.delivery ?? null,
        llm:llm.length,failedModel:llm.filter(a=>!a.success).length,tools:tool.length,toolFailures:tool.filter(a=>!a.success).length,
        toolNames:names,caseEvidenceCalls:checks.length};
    }finally{db.close();}
  }
  result.push({caseId:r.caseId,arm:r.arm,status:current.status,sentAt:current.timing?.questionSentAt,
    elapsedSeconds:current.timing?.questionSentAt?Math.round((Date.parse(current.timing?.completedAt||new Date().toISOString())-Date.parse(current.timing.questionSentAt))/1000):null,
    errors:current.timing?.errors,...inspection});
}
console.log(JSON.stringify(result,null,1));
