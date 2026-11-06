import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const armRoot=path.resolve(process.argv[2]);
const {AgentCore}=await import(pathToFileURL(path.join(armRoot,'packages/agent-core/dist/index.js')).href);
const {parseDraft}=await import(pathToFileURL(path.join(armRoot,'server/src/agent/draft_publication.ts')).href);
const v=(conclusion:string)=>JSON.stringify({answer:{conclusion,businessData:[],evidenceSummary:[],customerReply:'',pendingItems:[]},evidenceIds:[]});
async function run({name,success,incomplete,hook,action=false}:{name:string,success:boolean,incomplete:boolean,hook:boolean,action?:boolean}) {
 let n=0,queries=0;const texts:string[]=[];
 const t={name:'company_db_query',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>{queries++;return success?{status:'success',complete:!incomplete,rows:[['A']]}:{status:'error',message:'synthetic failure'};}};
 const c=new AgentCore({gateway:{getCurrentModel:()=> 'xkang-managed',switchModel(){},streamChat:async()=>{
  n++;if(n===1)return {role:'assistant',content:'',tool_calls:[{id:'q1',name:t.name,arguments:{}}]};
  return {role:'assistant',content:v(action?'我已为您执行修改。':incomplete?'只能确认本次返回条目为 A，不能认定完整名单。':'该订单已收款。')};}},
  registry:{getTools:()=>[t],getTool:()=>t,getRemoteSkills:()=>[],registerLocal(){},executeTool:()=>t.execute()},context:{repoPath:'',localCwd:''},buildPrompt:()=> 'offline test only',
  ...(hook?{review:async(candidate:any)=>{parseDraft(candidate.content,new Set());return {accepted:true,text:candidate.content};}}:{}),});
 const text=await c.run('查本条业务信息',(e:any)=>{if(e.type==='content_chunk')texts.push(e.chunk)});
 return {name,hook,modelCalls:n,queries,final:text,finalRecord:c.getMessages().at(-1).review??null,publicChunks:texts.length};
}
const cases=[];
for(const hook of [false,true])for(const kind of ['successful','all_failed','action_not_executed','partial_records'])cases.push(await run({name:kind,success:kind!=='all_failed',incomplete:kind==='partial_records',action:kind==='action_not_executed',hook}));
const output={arm:path.basename(armRoot),cases};
if(process.argv[3])fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify(output,null,2)+String.fromCharCode(10),{flag:'wx'});
console.log(JSON.stringify({arm:output.arm,cases:cases.map(c=>({name:c.name,hook:c.hook,modelCalls:c.modelCalls,rejected:!!c.finalRecord?.publicationFailure}))},null,2));
