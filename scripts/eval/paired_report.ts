import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './controlled_pair_helpers.js';
const flow=path.resolve(process.argv[2]);const batch=path.resolve(process.argv[3]);
const summary=readJson(path.join(batch,'all-summary.json'));const metrics=readJson(path.join(batch,'metrics.json'));
const validation=readJson(path.join(flow,'scores/validation.json'));if(!validation.valid)throw new Error('Score validation failed');
const key=readJson(path.join(flow,'blind-key.json'));
if(summary.repeats!==1)throw new Error('This scorecard expects one pre-registered round per batch; do not mix repeated answers.');
const cases=[...new Set(summary.runs.map((r:any)=>r.caseId))] as string[];
const scoreRecords=validation.records.filter((r:any)=>key.samples.some((m:any)=>m.runId.startsWith(summary.batchId+'-')&&m.blindAnswerId===r.blindAnswerId));
const classify=(rows:any[])=>{
 if(new Set(rows.map(r=>r.reviewer)).size!==2)return '未完成双评';
 const kinds=[...new Set(rows.map(r=>r.correctness))];return kinds.length===1?kinds[0]:'分歧：'+kinds.join('/');
};
const range=(a:number[])=>a.length?Math.min(...a)===Math.max(...a)?String(a[0]):Math.min(...a)+'–'+Math.max(...a):'—';
const limitFile=path.join(flow,'source-control-limitation.json');
const limitation=fs.existsSync(limitFile)?readJson(limitFile):null;
const sourceLimitation=limitation?.firstBatch===summary.batchId?limitation:null;
const result=[];
for(const id of cases){
 const arms:any={};
 for(const arm of ['baseline','candidate']){
  const row=metrics.rows.find((r:any)=>r.caseId===id&&r.arm===arm);const scores=scoreRecords.filter((r:any)=>r.caseId===id&&r.arm===arm);
  arms[arm]={status:row?.status||'PLANNED',grading:classify(scores),usability:range(scores.map((r:any)=>r.usability).filter((n:any)=>typeof n==='number')),
    correctUsable:new Set(scores.map((r:any)=>r.reviewer)).size===2&&scores.every((r:any)=>r.primary),seconds:row?.questionToDoneMs!=null?Math.round(row.questionToDoneMs/1000):null,
    explicitDelivery:row?.delivery||null,modelErrors:row?.modelErrors||[],evidenceCheckCalls:row?.caseEvidenceCalls||0,reviewers:scores.map((r:any)=>r.reviewer)};
 }
 result.push({caseId:id,...arms});
}
const graded=result.filter(c=>c.baseline.grading!=='未完成双评'&&c.candidate.grading!=='未完成双评');
const scorecard={generatedAt:new Date().toISOString(),batch:summary.batchId,caseCount:cases.length,gradedPairs:graded.length,sourceControl:sourceLimitation?.status??'not_attested_by_this_report',
  primary:{baseline:graded.filter(c=>c.baseline.correctUsable).length,candidate:graded.filter(c=>c.candidate.correctUsable).length,denominator:cases.length},
  cases:result,notes:['正确且客服可用：两次独立匿名评分均正确、可用性至少4且无核心错误断言。','评分者为AI独立上下文，不是两个人工专家；有分歧保留，不挑较好分。','运行状态COMPLETED仅表示会话结束；不等于交付成功或内容正确。','源/图谱/题面冻结；实时业务查询未整体快照。没有唯一人工gold，不确定处只评证据边界。']};
fs.writeFileSync(path.join(batch,'scorecard.json'),JSON.stringify(scorecard,null,2)+String.fromCharCode(10));
const lines=[graded.length===cases.length?'# 8例探索性对照结果':'# 冻结候选端到端对照（进度稿）','',
  sourceLimitation?'**同源性未证实**：同一请求别名背后允许多家provider。本表仅说明这些实际输出的质量，不用于证明候选相对基线的因果收益。':'本表仅汇总已结束运行和已验证匿名评分，不提前宣布胜负。',
  '', '| 用例 | 基线判断 | 候选判断 | 可用性：基线/候选 | 耗时秒：基线/候选 |','|---|---|---|---|---|',
  ...result.map(c=>'| '+c.caseId+' | '+c.baseline.grading+' | '+c.candidate.grading+' | '+c.baseline.usability+' / '+c.candidate.usability+' | '+(c.baseline.seconds??'—')+' / '+(c.candidate.seconds??'—')+' |'),
  '',...scorecard.notes.map(n=>'- '+n),
  '', '已完成双评 '+graded.length+'/'+cases.length+'；正确且可用 '+scorecard.primary.baseline+'/'+cases.length+' → '+scorecard.primary.candidate+'/'+cases.length+(graded.length===cases.length?'。全部原输出与失败保留。':'。未完成项尚不能判成功或失败。')];
fs.writeFileSync(path.join(batch,'scorecard.md'),lines.join(String.fromCharCode(10))+String.fromCharCode(10));
console.log(JSON.stringify({gradedPairs:graded.length,primary:scorecard.primary,cases:result.map(c=>({id:c.caseId,baseline:c.baseline.grading,candidate:c.candidate.grading}))},null,2));
