import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface JunctionEnv {
  base: string;
  /** 模拟的代码库根目录 */
  root: string;
  /** 库外目录（连接点指向它） */
  outside: string;
  /** 连接点是否创建成功（权限受限环境下为 false，用例应显式跳过） */
  linked: boolean;
  cleanup: () => void;
}

/**
 * 在 os.tmpdir() 下构造 root/ + outside/ + root/link（junction -> outside），
 * 用于验证符号链接/目录连接点不能绕过安全边界。绝不在 D:\skt_project 或任何真实仓库里建连接点。
 */
export function createJunctionEnv(): JunctionEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-junction-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'App.java'), 'class App {}\n');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    linked = true;
  } catch (error) {
    console.log(`[junction] 连接点创建失败（权限受限环境），相关用例将显式跳过: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { base, root, outside, linked, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
