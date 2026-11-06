import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** Client for the installed ZCode app-server's line-based protocol. */
export class ZCodeClient {
  pending = new Map();
  nextId = 0;
  constructor({ onNotification = () => {}, onStderr = () => {}, onRequest } = {}) {
    this.child = spawn('D:/zcode/ZCode.exe', ['D:/zcode/resources/glm/zcode.cjs', 'app-server', '--stdio', '--surface', 'desktop'], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'D:/zcode/resources/config/provider/zcode-builtin.json',
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:/Users/skt/.zcode/v2/provider_config.json',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', b => onStderr(b.toString()));
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.id !== undefined && response.method) {
        const handle = onRequest || (async request => {
          if (request.method === 'session/requestRuntimePreferences') return {
            nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true,
          };
          throw new Error(`Unsupported client request: ${request.method}`);
        });
        Promise.resolve(handle(response)).then(
          result => this.child.stdin.write(JSON.stringify({ id: response.id, result }) + '\n'),
          e => this.child.stdin.write(JSON.stringify({ id: response.id, error: { code: -32601, message: e.message } }) + '\n'),
        );
      } else if (response.id !== undefined && this.pending.has(response.id)) {
        const p = this.pending.get(response.id);
        this.pending.delete(response.id); clearTimeout(p.timer);
        if (response.error) p.reject(new Error(JSON.stringify(response.error)));
        else p.resolve(response.result);
      } else onNotification(response);
    });
    this.child.on('exit', code => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`ZCode exited ${code}`)); }
      this.pending.clear();
    });
  }
  request(method, params = {}, timeoutMs = 60000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}
