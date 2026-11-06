import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCompanyTools } from '../../server/src/tools/index.ts';
import { DEFAULT_FEATURE_FLAGS } from '../../server/src/types.ts';
import { readUsageLedger } from '../../server/src/usage_ledger.ts';

function fixtureRepo(withCredential: boolean): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-flags-'));
  const rel = 'skt-back/svc/src/main/java/com/x/AuthService.java';
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), withCredential ? 'class AuthService {\n  String password = "hardcoded123";\n}\n' : 'class AuthService {\n  String note = "ok";\n}\n');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const runRead = async (features: DEFAULT_FEATURE_FLAGS_TYPE | undefined, ledgerDir: string) => {
  const fx = fixtureRepo(true);
  const previous = process.env.USAGE_LEDGER_PATH;
  process.env.USAGE_LEDGER_PATH = path.join(ledgerDir, 'usage-ledger.jsonl');
  try {
    const tools = createCompanyTools(features ? { codeRepoPath: fx.root, features } as any : { codeRepoPath: fx.root } as any);
    const read = tools.find(t => t.name === 'read_file_lines')!;
    const out = await read.execute({ filePath: 'skt-back/svc/src/main/java/com/x/AuthService.java' }, features ? { codeRepoPath: fx.root, features } as any : { codeRepoPath: fx.root } as any, 'tester');
    return { out, ledger: readUsageLedger() };
  } finally {
    if (previous === undefined) delete process.env.USAGE_LEDGER_PATH; else process.env.USAGE_LEDGER_PATH = previous;
    fx.cleanup();
  }
};
type DEFAULT_FEATURE_FLAGS_TYPE = typeof DEFAULT_FEATURE_FLAGS;

test('R5：inputGuard 默认开启（未传 features 的旧调用方也脱敏）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-flags-ledger-'));
  try {
    const { out, ledger } = await runRead(undefined, dir);
    assert.ok(out.includes('***REDACTED:password***'), out);
    assert.ok(!out.includes('hardcoded123'));
    assert.equal(ledger.length, 1, '脱敏事件入台账');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R5：inputGuard=true 显式开启时脱敏；=false 时回到基线行为（不脱敏不记账）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-flags-ledger-'));
  try {
    const on = await runRead({ ...DEFAULT_FEATURE_FLAGS, inputGuard: true }, dir);
    assert.ok(on.out.includes('***REDACTED:password***'));
    assert.equal(on.ledger.length, 1);
    const off = await runRead({ ...DEFAULT_FEATURE_FLAGS, inputGuard: false }, dir);
    assert.ok(off.out.includes('hardcoded123'), '关闭后原文进入结果（基线行为）');
    assert.ok(!off.out.includes('***REDACTED'));
    assert.equal(off.ledger.length, 1, '关闭后不新增台账');
    // 默认台账里此时已有其它实验的记录：只断言脱敏事件可查且不含凭据值
    const guardEvents = readUsageLedger().filter(r => r.task === 'S6-input-guard');
    assert.ok(guardEvents.length >= 1, '默认台账可查到历史脱敏事件');
    assert.ok(guardEvents.some(r => typeof r.model === 'string' && r.model.length > 0), '脱敏事件记录工具名');
    assert.ok(guardEvents.every(r => !JSON.stringify(r).includes('hardcoded123')), '台账不含凭据值');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R5：DEFAULT_FEATURE_FLAGS 语义——S6 默认开、其余默认关', () => {
  assert.equal(DEFAULT_FEATURE_FLAGS.inputGuard, true);
  assert.equal(DEFAULT_FEATURE_FLAGS.partialPublish, false);
  assert.equal(DEFAULT_FEATURE_FLAGS.timeBudget, false);
  assert.equal(DEFAULT_FEATURE_FLAGS.feedbackBinding, false);
});

test('R5：正常文件在开/关两种配置下都不被误伤', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-flags-'));
  try {
    const rel = 'skt-back/svc/src/main/java/com/x/Plain.java';
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'class Plain {\n  String note = "ok";\n}\n');
    const tools = createCompanyTools({ codeRepoPath: root, features: DEFAULT_FEATURE_FLAGS } as any);
    const out = await tools.find(t => t.name === 'read_file_lines')!.execute({ filePath: rel }, { codeRepoPath: root, features: DEFAULT_FEATURE_FLAGS } as any, 'tester');
    assert.ok(out.includes('String note = "ok"'));
    assert.ok(!out.includes('REDACTED'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
