import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, canonicalJson } from './controlled_pair_helpers.js';
const batch=path.resolve(process.argv[2]);const summary=readJson(path.join(batch,'all-summary.json'));
const sha=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const dataProjection=(value:any)=>{
 if(value&&typeof value==='object'&&Array.isArray(value.columns)&&Array.isArray(value.rows)) {
   const cols=value.columns;const rows=value.rows.map((row:any)=>Array.isArray(row)?Object.fromEntries(cols.map((c:string,i:number)=>[c,row[i]])):row);
   return {columns:[...cols].sort(),rows:rows.map(canonicalJson).sort(),allNullColumns:value.allNullColumns||[],complete:value.complete,truncated:value.truncated,rowCount:value.rowCount};
 }
 return value;
};
function collect(run:any){const filename=path.join(run.dir,'private.json');const data=fs.existsSync(filename)?readJson(filename):null;const map=new Map<string,any>();
 for(const m of data?.messages||[]){if(m.role!=='tool'||!['company_db_query','search_logs','lookup_order'].includes(m.name))continue;
  let raw=m.raw_tool_result??m.content;if(typeof raw!=='string')continue;raw=raw.replace(/^【重复调用提示】[^\n]*\n/,'');let value:any;try{value=JSON.parse(raw)}catch{value={rawText:raw};}
  const args=m.evidence?.arguments||{};const exact=canonicalJson([m.name,args]);
  if(!map.has(exact))map.set(exact,{tool:m.name,args,argHash:sha([m.name,args]),outcomes:[],returnedHashes:[],evidenceIds:[]});const item=map.get(exact);
  item.outcomes.push(m.evidence?.outcome);item.returnedHashes.push(sha(dataProjection(value)));item.evidenceIds.push(m.evidence?.id);
 }
 return map;
}
const groups=new Map<string,any[]>();for(const r of summary.runs){const key=r.caseId+'-r'+r.round;if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(r);}
const result=[];
for(const [group,pair] of groups){if(pair.length!==2||pair.some(r=>['PLANNED','RUNNING'].includes(r.status)))continue;
 const baseline=pair.find(r=>r.arm==='baseline'),candidate=pair.find(r=>r.arm==='candidate');const a=collect(baseline),b=collect(candidate),matched=[];
 for(const [key,x] of a){const y=b.get(key);if(!y)continue;const hashes=[...new Set([...x.returnedHashes,...y.returnedHashes])];matched.push({tool:x.tool,args:x.args,argHash:x.argHash,observedEqual:hashes.length===1,baseline:{outcomes:x.outcomes,hashes:x.returnedHashes,evidenceIds:x.evidenceIds},candidate:{outcomes:y.outcomes,hashes:y.returnedHashes,evidenceIds:y.evidenceIds}});}
 result.push({case:group,exactCommonRequests:matched.length,differentReturnedProjections:matched.filter(m=>!m.observedEqual).length,baselineUniqueRequests:a.size,candidateUniqueRequests:b.size,matched});
}
const output={createdAt:new Date().toISOString(),method:'Only identical tool+arguments are compared. DB rows projected by column name and sorted to ignore incidental row order; business timestamps/values are never removed. Other JSON is exact. Differences may be live-data drift, output metadata or errors; this is a flag, not a causal attribution.',results:result};
fs.writeFileSync(path.join(batch,'evidence-comparability.json'),JSON.stringify(output,null,2)+String.fromCharCode(10));
console.log(JSON.stringify(result.map(({matched,...r})=>r),null,2));
