import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { redactText, redactToolResult } from '../../server/src/agent/input_guard.ts';
import { readUsageLedger } from '../../server/src/usage_ledger.ts';
import { createCompanyTools } from '../../server/src/tools/index.ts';

test('凭据形态一律脱敏，值替换为占位符', () => {
  const cases: Array<[string, string]> = [
    ['spring.datasource.password=Abc123456', 'spring.datasource.password=***REDACTED:spring.datasource.password***'],
    ['  datasource:\n    password: Abc123456', '  datasource:\n    password: ***REDACTED:password***'],
    ['url: jdbc:mysql://user:Passw0rd@host:3306/db', 'url: jdbc:mysql://user:***REDACTED:jdbc_password***@host:3306/db'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'Authorization: Bearer ***REDACTED:bearer_token***'],
    ['{"api_key":"a1b2c3d4e5f6g7h8"}', '{"api_key":"***REDACTED:api_key***"}'],
    ['String password = "hardcoded123"; // 源码里的硬编码', 'String password = "***REDACTED:password***"; // 源码里的硬编码'],
    ['7: if (token != null) { use(token); }', '7: if (token != null) { use(token); }'],
  ];
  for (const [input, expected] of cases) {
    const { text, hits } = redactText(input);
    if (input.startsWith('7:')) { assert.equal(text, expected); continue; }
    assert.equal(text, expected, input);
    assert.ok(hits.length >= 1, input);
    assert.ok(!text.includes('Abc123456') && !text.includes('Passw0rd') && !text.includes('eyJhbGci') && !text.includes('a1b2c3d4e5') && !text.includes('hardcoded123'));
  }
});

test('PEM 私钥块整体脱敏并记录起始行', () => {
  const pem = ['header line', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----', 'trailing'].join('\n');
  const { text, hits } = redactText(pem);
  assert.ok(!text.includes('MIIEowIBAAKCAQEA'));
  assert.ok(text.includes('***REDACTED:private_key_block***'));
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].kind, 'pem');
  assert.equal(text.split('\n').length, 3, '私钥块折叠为一行占位');
});

test('业务字段与正常文本不得脱敏（token_count/订单号/金额/中文）', () => {
  const lines = [
    'orderId: 1530517490084478976',
    'amount: 81.43',
    'token_count: 128',
    'orderNo: 9993903209296',
    '订单号：1530517490084478976，金额 81.43 元',
    '客户手机号 0013812345678，证件 11010119900101001X',
    'columns: ["order_id", "amount"]',
    'rows: [["1530517490084478976", "81.43"]]',
  ];
  for (const line of lines) {
    const { text, hits } = redactText(line);
    assert.equal(text, line, line);
    assert.equal(hits.length, 0, line);
  }
});

test('嵌套 JSON 与行号前缀输出里的敏感键也能脱敏', () => {
  assert.ok(redactText('{"db":{"password":"x"}}').text.includes('***REDACTED:password***'));
  assert.ok(redactText('12: private String password = "x";').text.includes('***REDACTED:password***'));
  assert.ok(redactText('access_key = ' + 'A'.repeat(40)).text.includes('***REDACTED'));
});

test('脱敏事件写入台账：只有工具名、条数与键名，没有值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-guard-'));
  const file = path.join(dir, 'usage-ledger.jsonl');
  const previous = process.env.USAGE_LEDGER_PATH;
  process.env.USAGE_LEDGER_PATH = file;
  try {
    const guarded = redactToolResult('read_file_lines', '3: String password = "hardcoded123";');
    assert.ok(guarded.includes('***REDACTED:password***'));
    assert.ok(guarded.includes('本结果中有字段已按安全策略脱敏'));
    assert.ok(!guarded.includes('hardcoded123'));
    const records = readUsageLedger(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].purpose, 'other');
    assert.equal(records[0].model, 'read_file_lines');
    assert.match(records[0].detail || '', /脱敏 1 处，键名: password/);
    assert.ok(!JSON.stringify(records[0]).includes('hardcoded123'));
    // 无命中时原样返回且不记台账
    assert.equal(redactToolResult('search_code', '命中 1 个文件'), '命中 1 个文件');
    assert.equal(readUsageLedger(file).length, 1);
  } finally {
    if (previous === undefined) delete process.env.USAGE_LEDGER_PATH; else process.env.USAGE_LEDGER_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('工具包装层：read_file_lines 读到的硬编码凭据在进模型前已被脱敏', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-guard-repo-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-guard-ledger-'));
  const previous = process.env.USAGE_LEDGER_PATH;
  process.env.USAGE_LEDGER_PATH = path.join(dir, 'usage-ledger.jsonl');
  try {
    const rel = 'skt-back/svc/src/main/java/com/x/AuthService.java';
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'class AuthService {\n  String password = "hardcoded123";\n}\n');
    const tools = createCompanyTools({ codeRepoPath: root } as any);
    const read = tools.find(t => t.name === 'read_file_lines')!;
    const out = await read.execute({ filePath: rel }, { codeRepoPath: root } as any, 'tester');
    assert.ok(out.includes('***REDACTED:password***'), out);
    assert.ok(!out.includes('hardcoded123'));
    assert.ok(out.includes('本结果中有字段已按安全策略脱敏'));
    assert.equal(readUsageLedger().length, 1);
  } finally {
    if (previous === undefined) delete process.env.USAGE_LEDGER_PATH; else process.env.USAGE_LEDGER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('company_db_query 的 columns+rows 形态按列位脱敏（值与键名不同行）', () => {
  const dbResult = JSON.stringify({ status: 'success', database: 'billing', columns: ['order_id', 'password', 'amount'], rows: [['1530517490084478976', 'hardcoded123', '81.43'], ['9993903209296', 'p@ss', '12.50']], complete: true });
  const { text, hits } = redactText(dbResult);
  assert.ok(!text.includes('hardcoded123') && !text.includes('p@ss'), text);
  assert.ok(text.includes('***REDACTED:password***'));
  assert.ok(text.includes('1530517490084478976'), '非敏感列原样保留');
  assert.ok(text.includes('81.43'));
  assert.equal(hits.some(h => h.kind === 'db_column'), true);
  // 无敏感列时原样返回
  const plain = JSON.stringify({ status: 'success', columns: ['order_id', 'amount'], rows: [['1530517490084478976', '81.43']] });
  assert.equal(redactText(plain).text, plain);
  // 截断/非 JSON 文本不走该分支，由逐行规则兜底
  assert.equal(redactText('password=Abc123456').text, 'password=***REDACTED:password***');
});
