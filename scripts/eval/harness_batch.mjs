import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { worker } from './compare_models.mjs';
const [reportDir, variant] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(path.join(reportDir, 'cases.json')));
const files = ['src/harness/agent.ts', 'src/harness/context.ts', 'src/adapters/server_proxy.ts', 'src/harness/system_prompt.ts'];
fs.writeFileSync(path.join(reportDir, `${variant}-loaded-source.json`), JSON.stringify({ at: new Date().toISOString(), hashes: Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')])) }, null, 2));
for (const round of [1, 2]) {
  for (const c of cases.filter(c => round === 1 || c.split === 'development')) {
    const dir = path.join(reportDir, `${variant}-${c.id}-${round}`);
    await worker(c.id, 'gemini', String(round), dir, c);
  }
}
