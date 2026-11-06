import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './controlled_pair_helpers.js';
const flow=path.resolve(process.argv[2]);const key=readJson(path.join(flow,'blind-key.json'));
const scores=fs.readdirSync(path.join(flow,'scores')).filter(f=>/^reviewer-.*\.json$/.test(f));
const template=readJson(path.join(flow,'rubric.json')).globalRules.scoreRecordTemplate;
const fields=Object.keys(template), failures:string[]=[], records:any[]=[], noteReferencesForReview:any[]=[];
const seen=new Set<string>();
const strings=(v:any):string[]=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):v&&typeof v==='object'?Object.values(v).flatMap(strings):[];
for(const f of scores){const s=readJson(path.join(flow,'scores',f));for(const r of s.records||[]){
 const scoreKey=String(s.reviewerId)+':'+r.blindAnswerId;
 if(seen.has(scoreKey))failures.push(f+': repeated reviewer/sample record');
 seen.add(scoreKey);
 const map=key.samples.find((m:any)=>m.blindAnswerId===r.blindAnswerId);if(!map){failures.push(f+': unknown sample '+r.blindAnswerId);continue;}
 const sample=readJson(path.join(map.pack,r.blindAnswerId+'.json'));const text=strings(sample.answer).join(String.fromCharCode(10));
 for(const field of fields)if(!(field in r))failures.push(f+': missing '+field);
 if(r.caseId!==map.caseId)failures.push(f+': wrong case');
 for(const w of r.wrongAsserted||[]){if(!w.quote||!text.includes(w.quote))failures.push(f+': non-verbatim wrong assertion '+String(w.quote).slice(0,40));}
 if(r.conclusionQuote&&!text.includes(r.conclusionQuote))failures.push(f+': non-verbatim conclusion');
 const mentioned=JSON.stringify([r.requiredAnswerChecks,r.wrongAsserted,r.unverifiedClaims]).match(/E\d{4}/g)||[];
 for(const e of new Set(mentioned))if(!sample.observedEvidence.includes(e))failures.push(f+': evidence outside sample '+e);
 const noteIds=[...new Set(String(r.reviewNotes||'').match(/E\d{4}/g)||[])].filter(e=>!sample.observedEvidence.includes(e));
 if(noteIds.length)noteReferencesForReview.push({file:f,sample:r.blindAnswerId,evidenceIds:noteIds,reason:'Free-form notes may mention evidence explicitly not used; verify manually rather than assuming it supported a claim.'});
 const reference=readJson(path.join(map.pack,'rubric.json'));const expected=reference.case.requiredAnswers.map((q:any)=>q.id).sort();const actual=(r.requiredAnswerChecks||[]).map((q:any)=>q.id).sort();
 if(JSON.stringify(expected)!==JSON.stringify(actual))failures.push(f+': missing requirement check '+r.blindAnswerId);
 const primary=r.conclusionCorrectness==='正确'&&r.usability>=4&&!(r.wrongAsserted||[]).some((w:any)=>w.impact==='核心');
 records.push({file:f,reviewer:s.reviewerId,caseId:r.caseId,blindAnswerId:r.blindAnswerId,arm:map.arm,round:map.round,correctness:r.conclusionCorrectness,usability:r.usability,subjectClosure:r.subjectClosure,chronology:r.chronology,actionability:r.actionability,clarity:r.clarity,primary,wrongCount:r.wrongAsserted?.length||0,coreWrongCount:r.wrongAsserted?.filter((w:any)=>w.impact==='核心').length||0});
}}
const grouped=new Map<string,any[]>();for(const r of records){if(!grouped.has(r.blindAnswerId))grouped.set(r.blindAnswerId,[]);grouped.get(r.blindAnswerId)!.push(r);}
const disagreement=[...grouped.entries()].filter(([,r])=>r.length>1&&['correctness','usability','subjectClosure','chronology','actionability','clarity'].some(k=>r[0][k]!==r[1][k])).map(([id,r])=>({sample:id,caseId:r[0].caseId,arm:r[0].arm,metrics:['correctness','usability','subjectClosure','chronology','actionability','clarity'].filter(k=>r[0][k]!==r[1][k]),records:r}));
const result={createdAt:new Date().toISOString(),valid:!failures.length,failures,noteReferencesForReview,records,disagreement};
fs.writeFileSync(path.join(flow,'scores','validation.json'),JSON.stringify(result,null,2)+String.fromCharCode(10));
console.log(JSON.stringify({valid:result.valid,failures,records,disagreement:disagreement.map(d=>({sample:d.sample,caseId:d.caseId,arm:d.arm,metrics:d.metrics}))},null,2));
if(failures.length)process.exitCode=1;
