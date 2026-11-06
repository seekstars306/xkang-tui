import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readJson } from './controlled_pair_helpers.js';
const batch=path.resolve(process.argv[2]);
const only=new Set((process.argv[3] || '').split(',').filter(Boolean));
const summary=readJson(path.join(batch,'all-summary.json'));
const flow=path.dirname(batch);
const bucket=process.argv[4] || 'blind';
if(!/^[A-Za-z0-9_-]+$/.test(bucket))throw new Error('Invalid blind bucket');
const out=path.join(flow,bucket);
fs.mkdirSync(out,{recursive:true});
const keyFile=path.join(flow,'blind-key.json');
const key=fs.existsSync(keyFile)?readJson(keyFile):{schema:1,createdAt:new Date().toISOString(),samples:[]};
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const write=(file:string,v:unknown)=>fs.writeFileSync(file,JSON.stringify(v,null,2)+String.fromCharCode(10),{flag:'wx'});
const contentText=(m:any)=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(String.fromCharCode(10)):'';
const redactRoot=(s:string)=>s.replaceAll(flow,'[EVALUATION]').replaceAll(flow.replaceAll('\\','/'),'[EVALUATION]').replace(/pair-\d{8}T\d{9}Z-[a-f0-9]{8}-[A-Za-z0-9_-]+/g,'[RUN]').replace(/s_[a-f0-9]{30,34}|r_[a-f0-9]{30,34}/g,'[SESSION]');
const groups=new Map<string,any[]>();for(const r of summary.runs){const k=r.caseId+'-r'+r.round;if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(r);}
for(const [group,runs] of groups){
  if(only.size&&!only.has(runs[0].caseId))continue;
  if(runs.length!==2||runs.some(r=>r.status==='PLANNED'||r.status==='RUNNING'))continue;
  const target=path.join(out,group);if(fs.existsSync(target)){const prior=key.samples.filter((s:any)=>s.pack===target);if(prior.length!==2||prior.some((s:any)=>!runs.some(r=>r.runId===s.runId)))throw new Error('Blind output already belongs to another batch');console.log(JSON.stringify({case:group,skipped:'already_frozen'}));continue;}
  fs.mkdirSync(path.join(target,'evidence'),{recursive:true});fs.mkdirSync(path.join(target,'images'),{recursive:true});
  const input=readJson(runs[0].input.file), original=input.messages[0].content;
  const text=typeof original==='string'?original:original.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(String.fromCharCode(10));
  const images:any[]=[];
  for(const p of Array.isArray(original)?original:[]){if(p.type!=='image_url')continue;const m=/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(p.image_url.url);if(!m)throw new Error('unexpected image');const b=Buffer.from(m[2],'base64');const filename='image-'+(images.length+1)+'.'+m[1];fs.writeFileSync(path.join(target,'images',filename),b,{flag:'wx'});images.push({file:'images/'+filename,sha256:sha(b)});}
  write(path.join(target,'input.json'),{caseId:runs[0].caseId,question:text,images,originalInputSha256:sha(fs.readFileSync(runs[0].input.file))});
  const refs=new Map<string,string>(), index:any[]=[], samples:any[]=[];
  const shuffled=[...runs];if(randomInt(2))shuffled.reverse();
  for(const run of shuffled){
    const privateData=readJson(path.join(run.dir,'private.json'));const publicData=readJson(path.join(run.dir,'public.json'));
    const id='S'+randomBytes(4).toString('hex');const answer=publicData?.turns?.at(-1)?.answer;
    const observed:string[]=[];
    for(const m of privateData?.messages || []){
      if(m.role!=='tool')continue;
      const raw=redactRoot(m.raw_tool_result ?? contentText(m));
      const args=m.evidence?.arguments || {};
      const fingerprint=sha(JSON.stringify([m.name,args,raw]));
      let evidenceId=refs.get(fingerprint);
      if(!evidenceId){
        evidenceId='E'+String(index.length+1).padStart(4,'0');refs.set(fingerprint,evidenceId);
        let result:any;try{result=JSON.parse(raw);}catch{result={rawText:raw};}
        const meta={evidenceId,tool:m.name,args,outcome:m.evidence?.outcome??'unknown',completeness:m.evidence?.completeness??'unknown',observedDate:m.evidence?.observedAt?.slice(0,10)??null,collectionTimeNotEvent:true};
        write(path.join(target,'evidence',evidenceId+'.json'),{...meta,result,rawSha256:sha(raw)});
        index.push({...meta,file:'evidence/'+evidenceId+'.json',chars:raw.length,preview:raw.replace(/[\r\n]+/g,' ').slice(0,160)});
      }
      observed.push(evidenceId);
    }
    const businessFields=answer?Object.fromEntries(['conclusion','businessData','evidenceSummary','customerReply','pendingItems','claims'].filter(k=>answer[k]!==undefined).map(k=>[k,answer[k]])):null;
    // Hide arm, status metadata, timings and internal drafts; grade only the text actually delivered.
    write(path.join(target,id+'.json'),{blindAnswerId:id,caseId:run.caseId,answer:businessFields,observedEvidence:[...new Set(observed)],note:'来源与耗时隐藏；只有上述公开业务字段交付给用户，未展示的推理/草稿不得补分。'});
    samples.push({blindAnswerId:id,file:id+'.json'});
    key.samples.push({blindAnswerId:id,caseId:run.caseId,round:run.round,arm:run.arm,runId:run.runId,runDir:run.dir,pack:target});
  }
  const rubric=readJson(path.join(flow,'rubric.json'));
  write(path.join(target,'rubric.json'),{rubricVersion:rubric.rubricVersion,globalRules:rubric.globalRules,case:rubric.cases[runs[0].caseId]});
  write(path.join(target,'evidence-index.json'),index);
  write(path.join(target,'pack.json'),{schema:1,caseId:runs[0].caseId,input:'input.json',rubric:'rubric.json',samples,evidenceIndex:'evidence-index.json',policy:'同范围完整工具返回目录，仅限内部评分；既有代码机制不证明历史实际执行；查询失败也保留。按每个sample的observedEvidence核查来源，别把另一答案独有的发现补成此答案已取到证据。工具verdict、调用数量或篇幅不加分。'});
  console.log(JSON.stringify({case:group,samples:samples.length,evidence:index.length,images:images.length}));
}
fs.writeFileSync(keyFile,JSON.stringify(key,null,2)+String.fromCharCode(10));
