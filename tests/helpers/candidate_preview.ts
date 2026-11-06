import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startBusinessFixture } from './business_fixture.ts';

const executable = path.resolve(process.argv[2] || 'out/xhang-2.0.0-candidate.exe');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-exe-qa-'));
const fixture = await startBusinessFixture();
const child = spawn(executable, ['--server', fixture.url, '--token', fixture.token, '--port', '8676', '--no-open'], {
  cwd: directory, env: { ...process.env, USERPROFILE: directory, HOME: directory, WEB_NO_OPEN: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
console.log(JSON.stringify({ executable, url: 'http://127.0.0.1:8676', temporaryProfile: directory }));
const stop = async () => { child.kill(); await fixture.stop(); process.exit(0); };
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
