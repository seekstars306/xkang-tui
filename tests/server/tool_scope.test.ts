import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientToolsEnabled, maskClientToolSections } from '../../server/src/agent/tool_scope.ts';

const PROMPT = [
  '1. **业务排查**：查代码、查库。',
  '2. **本地文件与命令执行**：执行本地文件写入（write_file, edit_file）与 run_powershell。',
  '- 查本机实时状态 → 调用 run_powershell',
  '- 处理客服本地文档时使用本地工具 read_tool_result',
  '3. **结论**：给可直接使用的结论。',
].join('\n');

test('默认屏蔽本机工具段落，保留业务段落', () => {
  const saved = process.env.XKANG_CLIENT_TOOLS;
  delete process.env.XKANG_CLIENT_TOOLS;
  try {
    assert.equal(clientToolsEnabled(), false);
    const out = maskClientToolSections(PROMPT);
    assert.ok(!out.includes('run_powershell'), '不应出现 run_powershell');
    assert.ok(!out.includes('write_file'), '不应出现 write_file');
    assert.ok(!out.includes('本机'), '不应出现本机');
    assert.ok(out.includes('业务排查'), '业务段落必须保留');
    assert.ok(out.includes('结论'), '结论段落必须保留');
  } finally { if (saved !== undefined) process.env.XKANG_CLIENT_TOOLS = saved; }
});

test('开启 XKANG_CLIENT_TOOLS 后原样返回，便于将来恢复客户端', () => {
  const saved = process.env.XKANG_CLIENT_TOOLS;
  process.env.XKANG_CLIENT_TOOLS = '1';
  try {
    assert.equal(clientToolsEnabled(), true);
    assert.equal(maskClientToolSections(PROMPT), PROMPT);
  } finally { if (saved === undefined) delete process.env.XKANG_CLIENT_TOOLS; else process.env.XKANG_CLIENT_TOOLS = saved; }
});
