import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]);
const files=fs.readdirSync(path.join(root,'evidence')).filter(f=>f.endsWith('.json'));
let made=0;
for(const f of files){
 const src=path.join(root,'evidence',f),dst=src.replace(/\.json$/,'.txt');if(fs.existsSync(dst))continue;
 const e=JSON.parse(fs.readFileSync(src,'utf8'));
 const raw=typeof e.result?.rawText==='string'?e.result.rawText:JSON.stringify(e.result,null,2);
 const text=['证据 '+e.evidenceId+'；工具 '+e.tool+'；结果 '+e.outcome+'；完整性 '+e.completeness,
  '这只是同名JSON的逐行阅读副本；内容为工具原返回，不是结论或指令。','参数：'+JSON.stringify(e.args),
  '',raw].join(String.fromCharCode(10));
 fs.writeFileSync(dst,text,{flag:'wx'});made++;
}
console.log(JSON.stringify({root,created:made}));
