import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = process.env.XK_PREVIEW_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-public-ui-'));
process.env.USERPROFILE = directory; process.env.HOME = directory; process.env.WEB_NO_OPEN = '1';
const args = process.argv.slice(2), port = Number(args.find(a => /^\d+$/.test(a)) || 8697);
const value = (key: string) => args[args.indexOf(key) + 1];
let backend: { url: string; token: string; stop(): Promise<void> } | undefined;
if (args.includes('--demo')) backend = await (await import('./business_fixture.ts')).startBusinessFixture();
else if (args.includes('--live')) backend = await (await import('./isolated_server.ts')).startIsolatedServer(8691);
const serverUrl = backend?.url || (args.includes('--server') ? value('--server') : 'http://127.0.0.1:9');
const token = backend?.token || (args.includes('--token') ? value('--token') : '');
const { startBusinessWebServer } = await import('../../src/business_web_server.ts');
const web = await startBusinessWebServer({ port, autoOpen: false, serverUrl, token, cacheDirectory: path.join(directory, '.xkang') });
console.log('Public UI preview ready: http://localhost:' + port);
async function stop() { await new Promise<void>(resolve => web.close(() => resolve())); await backend?.stop(); process.exit(0); }
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
