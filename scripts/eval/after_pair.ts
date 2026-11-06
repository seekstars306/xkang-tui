import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson } from './controlled_pair_helpers.js';
const predecessor=path.resolve(process.argv[2]);
const candidate=path.resolve(process.argv[3]);
const target=path.resolve(process.argv[4]);
const summaryFile=path.join(predecessor,'all-summary.json');
if(fs.existsSync(target))throw new Error('Next batch directory must be new');
const ready=await new Promise<any>((resolve,reject)=>{
 let finished=false;
 const end=(err:Error|null,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timeout);watcher.close();err?reject(err):resolve(value);};
 const inspect=()=>{
  try{const summary=readJson(summaryFile);if(!summary.completedAt)return;
   if(summary.errors?.length||summary.runs?.some((r:any)=>['RUNNING','PLANNED','NOT_STARTED_INFRA','INFRA_INTERRUPTED'].includes(r.status)))return end(new Error('Predecessor has infrastructure failures; explicit review required'));
   if(summary.runs?.length!==16)return end(new Error('Unexpected predecessor coverage'));
   end(null,summary);
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')end(new Error('Cannot verify predecessor summary'));}
 };
 const watcher=fs.watch(predecessor,(_event,name)=>{if(String(name)==='all-summary.json')inspect();});
 const timeout=setTimeout(()=>end(new Error('Timed out waiting for predecessor completion')),90*60_000);
 inspect();
});
console.log(JSON.stringify({step:'predecessor_complete',batch:ready.batchId,runs:ready.runs.length,completedAt:ready.completedAt,nextCandidate:candidate,nextOutput:target}));
const cli=path.resolve('scripts/eval/controlled_pair.ts');
const child=spawn(process.execPath,['--import','tsx',cli,'--repeats=1','--candidate='+candidate,'--run-dir='+target],{cwd:process.cwd(),env:process.env,stdio:'inherit',windowsHide:true});
const shutdown=()=>child.kill('SIGTERM');process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
child.once('error',()=>{console.error('Next batch process could not start');process.exitCode=1;});
child.once('exit',(code,signal)=>{process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);console.log(JSON.stringify({step:'next_batch_exit',code,signal}));process.exitCode=code===0?0:1;});
