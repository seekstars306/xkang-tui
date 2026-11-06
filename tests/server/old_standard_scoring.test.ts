import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOldAnswer, oldItemIds, oldScoreHash, prepareOldPack, validateOldScores, type OldSource } from '../../scripts/eval/old_standard_scoring.js';

const rubric = { A: { question: 'synthetic A', items: ['A1 status', 'A2 action'] }, B: { question: 'synthetic B', items: ['only fact'] } };
function fixture() {
  const sources: OldSource[] = ['old','candidate'].flatMap(condition => ['A','B'].map(ticket => ({
    condition, ticket, runId: condition + '-' + ticket, status: 'COMPLETED',
    publicAnswer: { conclusion: 'Synthetic answer', businessData: [{ label: 'flag', value: 'test' }], evidenceSummary: ['fixture'], customerReply: 'Useful answer', pendingItems: [] }
  })));
  const {pack,key} = prepareOldPack(rubric,sources,['old','candidate'],['A','B']);
  const reviewers = ['r1','r2'].map(reviewerId => ({reviewerId,records:pack.answers.map(a => ({
    blindId:a.blindId,ticket:a.ticket,items:Object.fromEntries(oldItemIds(pack.rubrics[a.ticket]).map(k=>[k,'hit'])),wrongClaims:[] as {quote:string;where:string}[],
    usable:5,correct:'correct',answersQuestion:'yes',saysWhatToDo:'yes',clarity:5,issues:[] as string[],note:'synthetic'
  }))}));
  return {sources,pack,key,reviewers};
}
const run = (f: ReturnType<typeof fixture>) => validateOldScores(f.pack,f.key,f.reviewers,f.sources);

test('old format remains exact and a conclusion-only answer is not discarded', () => {
  const f=fixture(),s=f.sources[0];
  assert.equal(formatOldAnswer(s).text,'结论：Synthetic answer\n\n业务数据：\n- flag：test\n\n依据：\n- fixture\n\n给提问人的回复：Useful answer');
  s.publicAnswer={conclusion:'This result is incomplete in scope but establishes one useful fact.'};
  assert.equal(formatOldAnswer(s).noAnswer,false);
  const clean=fixture(),input=JSON.stringify(clean);run(clean);assert.equal(JSON.stringify(clean),input);
});

test('missing or duplicate condition-case pairs cannot hide in an unchanged row count', () => {
  const f=fixture();f.sources[1]={...f.sources[0],runId:'other-run'};
  assert.throws(()=>prepareOldPack(rubric,f.sources,['old','candidate'],['A','B']),/DUPLICATE_CASE/);
  assert.throws(()=>prepareOldPack(rubric,f.sources.slice(1),['old','candidate'],['A','B']),/SOURCE_CARDINALITY/);
  const g=fixture();g.sources[0].condition='unexpected';assert.throws(()=>prepareOldPack(rubric,g.sources,['old','candidate'],['A','B']),/UNPLANNED_SOURCE/);
});

test('each answer requires exactly two complete distinct reviewers without duplicates', () => {
  for(const change of [
    (f:ReturnType<typeof fixture>)=>{f.reviewers[1].reviewerId='r1';},
    (f:ReturnType<typeof fixture>)=>{f.reviewers.pop();},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records.pop();},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[1]=f.reviewers[0].records[0];},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[0].blindId='not-in-pack';}
  ]){const f=fixture();change(f);assert.throws(()=>run(f));}
});

test('unknown grades, invalid rubric IDs and nonverbatim quotes fail before aggregation', () => {
  for(const change of [
    (f:ReturnType<typeof fixture>)=>{const r=f.reviewers[0].records[0];r.items[Object.keys(r.items)[0]]='unknown';},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[0].correct='probably';},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[0].usable=6;},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[0].items={other:'hit'};},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[0].wrongClaims=[{quote:'Synthetic  answer',where:'asserted'}];},
    (f:ReturnType<typeof fixture>)=>{f.reviewers[0].records[0].wrongClaims=[{quote:'',where:'asserted'}];}
  ]){const f=fixture();change(f);assert.throws(()=>run(f));}
  assert.throws(()=>oldItemIds({items:['A1 first','A1 second']}),/DUPLICATE_ITEM_IDS/);
});

test('rewriting pack and matching its key hash still fails against original delivered source', () => {
  const f=fixture(),a=f.pack.answers[0];a.answer+=' Forged fact';
  const k=f.key.samples.find(s=>s.blindId===a.blindId)!;k.answerSha256='forged matching hash';
  assert.throws(()=>run(f),/ANSWER_DRIFT/);
  const g=fixture();g.sources[0].publicAnswer={conclusion:'changed source'};assert.throws(()=>run(g),/SOURCE_DRIFT/);
  const h=fixture();h.pack.rubrics.A.items[0]='A1 changed criterion';assert.throws(()=>run(h),/RUBRIC_DRIFT/);
});

test('source-derived no-answer rule applies even if reviewer tries to award correct/hit', () => {
  const f=fixture();f.sources[0].publicAnswer={conclusion:'本次尚未形成可直接采信的业务结论，需要继续核实。',businessData:[],evidenceSummary:[],customerReply:'您的问题仍在核实，请由二线人员继续跟进。',pendingItems:['当前结论未完成复核。']};
  const built=prepareOldPack(rubric,f.sources,['old','candidate'],['A','B']);
  const byPair=new Map(f.key.samples.map(s=>[s.blindId,JSON.stringify([s.condition,s.ticket])]));
  for(const review of f.reviewers)for(const r of review.records){const p=byPair.get(r.blindId);r.blindId=built.key.samples.find(s=>JSON.stringify([s.condition,s.ticket])===p)!.blindId;}
  f.pack=built.pack;f.key=built.key;
  assert.throws(()=>run(f),/NO_ANSWER_RULE/);
  const empty=f.key.samples.find(s=>s.noAnswer)!;
  for(const review of f.reviewers){const r=review.records.find(r=>r.blindId===empty.blindId)!;r.usable=1;r.correct='none';r.answersQuestion='no';r.saysWhatToDo='no';r.clarity=3;r.items=Object.fromEntries(Object.keys(r.items).map(k=>[k,'miss']));}
  const result=run(f);assert.equal(result.samples,4);assert.equal(result.aggregates[0].usable,3);
});

test('placeholder conclusion does not erase a real customer reply or a pending claim', () => {
  const source=fixture().sources[0];
  const fallback={conclusion:'本次尚未形成可直接采信的业务结论，需要继续核实。',businessData:[],evidenceSummary:[],customerReply:'您的问题仍在核实，请由二线人员继续跟进。',pendingItems:['当前结论未完成复核。']};
  assert.equal(formatOldAnswer({...source,publicAnswer:fallback}).noAnswer,true);
  const reply={...fallback,customerReply:'订单已取消，立即重新提交。'};
  assert.equal(formatOldAnswer({...source,publicAnswer:reply}).noAnswer,false);
  assert.match(formatOldAnswer({...source,publicAnswer:reply}).text,/订单已取消/);
  assert.equal(formatOldAnswer({...source,publicAnswer:{...fallback,pendingItems:['退款100元已到账。']}}).noAnswer,false);
  assert.equal(formatOldAnswer({...source,publicAnswer:{...fallback,customerReply:'',pendingItems:[]}}).noAnswer,true);
});

test('absent, malformed and nonterminal sources are not silently converted into empty answers', () => {
  const f=fixture();
  for(const value of [undefined,{},'bare text',{conclusion:'x',businessData:'bad'}, {conclusion:'x',businessData:[{label:'x',value:9}]}]){
    const source={...f.sources[0],publicAnswer:value};assert.throws(()=>formatOldAnswer(source));
  }
  const missing={...f.sources[0],status:'INFRA_INTERRUPTED',publicAnswer:null};
  assert.throws(()=>formatOldAnswer(missing),/MISSING_DELIVERY_EVIDENCE/);
  assert.deepEqual(formatOldAnswer({...missing,missingDelivery:{reason:'no public event',evidence:'run.json:terminal error'}}),{text:'结论：',noAnswer:true});
  f.sources[0].status='RUNNING';assert.throws(()=>prepareOldPack(rubric,f.sources,['old','candidate'],['A','B']),/SOURCE_NOT_TERMINAL/);
});

test('an unrun Sonnet condition cannot be replaced with a fabricated empty source', () => {
  const f=fixture();
  assert.throws(()=>prepareOldPack(rubric,f.sources,['old','candidate','sonnet'],['A','B']),/SOURCE_CARDINALITY/);
  const fake:OldSource={condition:'sonnet',ticket:'A',runId:'pending-sonnet',status:'PLANNED',publicAnswer:null};
  assert.throws(()=>prepareOldPack(rubric,[...f.sources,fake,{...fake,ticket:'B',runId:'pending-sonnet-B'}],['old','candidate','sonnet'],['A','B']),/SOURCE_NOT_TERMINAL/);
});

test('macro averages preserve per-case weights and disagreements are not reconciled upward', () => {
  const f=fixture();for(const review of f.reviewers)for(const r of review.records){const k=f.key.samples.find(s=>s.blindId===r.blindId)!;if(k.condition==='old'&&r.ticket==='A')r.items={A1:'miss',A2:'miss'};}
  const target=f.reviewers[0].records.find(r=>f.key.samples.find(s=>s.blindId===r.blindId)!.condition==='old'&&r.ticket==='B')!;
  target.correct='partial';target.usable=3;target.wrongClaims=[{quote:'Synthetic answer',where:'asserted'}];
  const before=oldScoreHash(f),result=run(f),a=result.aggregates.find(a=>a.condition==='old')!;
  assert.equal(oldScoreHash(f),before);assert.equal(a.pointScore,.5);assert.notEqual(a.pointScore,1/3);
  assert.equal(a.usable,4.5);assert.equal(a.correctnessScore,.875);assert.equal(a.bothCorrectAndUsable,1);
  assert.equal(result.disagreements.length,1);assert.equal(a.wrongAssertedAverage,.25);
});

test('six-case macro comparison retains differences that round to the same displayed score', () => {
  const tickets=['A','B','C','D','E','F'];
  const rubrics=Object.fromEntries(tickets.map(t=>[t,{items:Array.from({length:t==='B'?9:1},(_,i)=>String(i+1)+' fact')}]));
  const sources:OldSource[]=['old','new'].flatMap(condition=>tickets.map(ticket=>({condition,ticket,runId:condition+'-'+ticket,status:'COMPLETED',publicAnswer:{conclusion:'Synthetic fact'}})));
  const {pack,key}=prepareOldPack(rubrics,sources,['old','new'],tickets);
  const reviewers=['r1','r2'].map(reviewerId=>({reviewerId,records:pack.answers.map(a=>{
    const condition=key.samples.find(k=>k.blindId===a.blindId)!.condition;
    return {blindId:a.blindId,ticket:a.ticket,items:Object.fromEntries(oldItemIds(pack.rubrics[a.ticket]).map((k,i)=>[k,a.ticket==='A'?'hit':a.ticket==='B'&&condition==='new'&&reviewerId==='r1'&&i===0?'partial':'miss'])),wrongClaims:[],usable:3,correct:'partial',answersQuestion:'partly',saysWhatToDo:'no',clarity:3,issues:[],note:'synthetic'};
  })}));
  const result=validateOldScores(pack,key,reviewers,sources),old=result.aggregates[0].pointScore,next=result.aggregates[1].pointScore;
  assert.ok(Math.abs(old-1/6)<1e-12);assert.ok(Math.abs(next-37/216)<1e-12);
  assert.equal(old.toFixed(2),next.toFixed(2));assert.ok(next>old);
});
