import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FixtureRepo {
  root: string;
  cleanup: () => void;
}

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * 构造一个与 D:\skt_project 结构相同的小型代码库：
 * skt-front（前端）、skt-back / skt-back-new / skt-remote（后端），
 * 含嵌套 git 仓库、同名文件、node_modules 噪声、GBK 编码文件和用于翻页的大量命中文件。
 */
export function createFixtureRepo(): FixtureRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-fixture-'));

  write(root, 'skt-front/app_pc/src/views/UserEditDialog.vue', [
    '<template>',
    '  <el-form-item label="账户类型">',
    '    <el-select v-model="form.accountType" />',
    '  </el-form-item>',
    '  <el-button @click="save">保存</el-button>',
    '</template>',
  ].join('\n'));
  write(root, 'skt-front/app_pc/src/config/constants.js', "export const ACCOUNT_TYPE_LABEL = '账户类型';\n");
  write(root, 'skt-front/app_pc/node_modules/lib/index.js', "module.exports = '账户类型';\n");

  const serviceLines: string[] = ['package com.x;', '', 'public class OrderService {', '  public void changeOrder(OrderAir old) {'];
  for (let i = serviceLines.length + 1; i <= 128; i++) serviceLines.push(`    // filler line ${i}`);
  serviceLines.push('    OrderAir orderAir = OrderCommonUtils.orderAirCopy(old); // line 129');
  for (let i = serviceLines.length + 1; i <= 168; i++) serviceLines.push(`    // filler line ${i}`);
  serviceLines.push('    orderAir.setReceivableState(0); // line 169 reset');
  for (let i = serviceLines.length + 1; i <= 200; i++) serviceLines.push(`    // filler line ${i}`);
  serviceLines.push('  }', '}');
  write(root, 'skt-back/svc/src/main/java/com/x/OrderService.java', serviceLines.join('\n'));

  write(root, 'skt-back/svc/src/main/java/com/x/util/OrderCommonUtils.java', 'public class OrderCommonUtils { void orderAirCopy() { setReceivableState(1); } }\n');
  write(root, 'skt-back/other/src/main/java/com/y/util/OrderCommonUtils.java', 'public class OrderCommonUtils { }\n');
  write(root, 'skt-back/svc/src/main/java/com/x/PayService.java', 'class PayService { void pay() { refundFee(); checkOrder(); } }\n');
  write(root, 'skt-back/svc/src/main/java/com/x/OnlyRefund.java', 'class OnlyRefund { void a() { refundFee(); } }\n');
  write(root, 'skt-back-new/hotel/README.md', '# hotel\n');
  write(root, 'skt-remote/sdk/Client.java', '// 账户类型 mapping\nclass Client {}\n');
  for (let i = 1; i <= 40; i++) {
    const n = String(i).padStart(2, '0');
    write(root, `skt-back/svc/src/main/java/com/x/gen/Gen${n}.java`, `class Gen${n} {\n  String commonToken = "v${i}";\n}\n`);
  }
  // GBK 编码的老代码文件："收款状态" 的 GBK 字节
  const gbk = Buffer.concat([Buffer.from('// '), Buffer.from([0xca, 0xd5, 0xbf, 0xee, 0xd7, 0xb4, 0xcc, 0xac]), Buffer.from('\nclass Legacy {}\n')]);
  write(root, 'skt-back/svc/legacy/Legacy.java', gbk);

  // skt-back/svc 是一个独立的 git 仓库（与真实代码库一样，根目录本身不是仓库）
  const gitDir = path.join(root, 'skt-back', 'svc');
  const git = (...args: string[]) => execFileSync('git', ['-C', gitDir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com', 'add', '-A');
  git('-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'init order service');

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
