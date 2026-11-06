import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createControlledProxy, MODEL_CANON, normalizeModelRequest } from '../../scripts/eval/controlled_model_proxy.ts';
const listen = (s:Server) => new Promise<string>(resolve=>s.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+(s.address() as any).port)));
const close = async(s:Server) => {s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));};

test('代理只规范模型参数，保留输入、工具与输出格式并不修改源对象',()=>{
  const body={model:'alias',reasoning_effort:'low',thinking:{type:'enabled'},max_completion_tokens:384000,temperature:0.7,messages:[{role:'user',content:'fixture'}],tools:[{type:'function',function:{name:'lookup'}}],response_format:{type:'json_object'},stream:true};
  const before=JSON.stringify(body), n=normalizeModelRequest(body);
  for(const [k,v] of Object.entries(MODEL_CANON))assert.equal(n[k],v);
  assert.equal(n.max_completion_tokens,undefined);assert.equal(n.temperature,undefined);assert.equal(n.thinking,undefined);
  assert.deepEqual(n.messages,body.messages);assert.deepEqual(n.tools,body.tools);assert.deepEqual(n.response_format,body.response_format);
  assert.equal(JSON.stringify(body),before);
});
test('代理按每run 1/global 2限流，记录排队和usage，不记录正文或密钥', async()=>{
  const captured:any[]=[], logs:any[]=[], waiting:(()=>void)[]=[];
  let active=0,max=0;
  const upstream=createServer(async(req,res)=>{
    const parts:Buffer[]=[];for await(const c of req)parts.push(Buffer.from(c));
    captured.push({body:JSON.parse(Buffer.concat(parts).toString()),auth:req.headers.authorization});active++;max=Math.max(max,active);
    const send=()=>{active--;res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({model:'deepseek-v4.1-flash',choices:[{finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2,completion_tokens_details:{reasoning_tokens:1}}})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10));};
    if(captured.length<3)waiting.push(send);else send();
    if(captured.length===2){assert.equal(active,2);while(waiting.length)waiting.shift()!();}
  });
  const up=await listen(upstream), proxy=createControlledProxy({upstream:up,key:'private-upstream-key',log:r=>logs.push(r)});
  const base=await listen(proxy);
  try {
    const send=(run:string)=>fetch(base+'/run/'+run+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer incoming-key'},body:JSON.stringify({model:'m',stream:true,messages:[{role:'user',content:'private-customer-text'}]})}).then(r=>r.text());
    await Promise.all([send('a'),send('a'),send('b')]);
    assert.equal(captured.length,3);assert.equal(max,2);assert.equal(logs.length,3);
    assert.ok(logs.every(l=>l.normalized.reasoning_effort==='max'&&l.normalized.max_tokens===128000&&l.httpStatus===200));
    assert.ok(captured.every(c=>c.auth==='Bearer private-upstream-key'));
    assert.ok(logs.every(l=>l.queueMs>=0&&l.usage.completion_tokens===2));
    assert.doesNotMatch(JSON.stringify(logs),/private-upstream-key|incoming-key|private-customer-text/);
  } finally {await close(proxy);await close(upstream);}
});
