#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenManager } from '../server/dist/token_manager.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.resolve(SCRIPT_DIR, '..', 'server', 'data', 'tokens.json');
const SERVER_BASE = 'http://10.197.15.89:8600';
const manager = new TokenManager(TOKENS_PATH);

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

// 支持 --name/-n 标志参数，也兼容位置参数: create "客服-张三"
function extractNameArg(argList) {
  const flagIdx = argList.findIndex((a) => a === '--name' || a === '-n');
  if (flagIdx !== -1) {
    const val = argList[flagIdx + 1]?.trim();
    if (val && !val.startsWith('-')) return val;
    console.error('❌ 错误: --name 后需指定客服姓名，例如: create --name "客服-李四"');
    process.exit(1);
  }
  const positional = argList[1]?.trim();
  return positional && !positional.startsWith('-') ? positional : '';
}

function printHelp() {
  console.log(`
========================================================================
🔑 小康 TUI 客服排障终端 - Key 授权与设备绑定管理中心
========================================================================

使用方法:
  node scripts/manage_keys.mjs <command> [arguments]

可用指令:
  create <员工姓名>           为新客服生成专属 Key 与一键开箱配置
  list                       查看所有已分发的 Key、启用状态及已绑定的电脑设备
  unbind <Token>             解绑指定 Key 的电脑设备 (客服换电脑时使用)
  enable <Token>             启用指定的 Key
  disable <Token>            停用指定的 Key (离职或权限回收)
  delete <Token>             彻底删除指定的 Key

示例:
  node scripts/manage_keys.mjs create "客服-张三"
  node scripts/manage_keys.mjs list
  node scripts/manage_keys.mjs unbind "tok_skt_a1b2c3d4e5"
========================================================================
`);
}

switch (command) {
  case 'create': {
    const name = extractNameArg(args);
    if (!name) {
      console.error('❌ 错误: 请指定客服姓名，例如: node scripts/manage_keys.mjs create "客服-李四" 或 create --name "客服-李四"');
      process.exit(1);
    }
    const record = manager.createToken(name);
    console.log('\n========================================================================');
    console.log(`🎉 成功为【${record.name}】生成专属排障 Key！`);
    console.log('========================================================================');
    console.log(`- 员工姓名: ${record.name}`);
    console.log(`- 访问令牌 (Key): ${record.token}`);
    console.log(`- 设备绑定状态: 尚未绑定 (首次使用时将自动锁定首台电脑，严禁多人共用)`);
    console.log(`- 创建时间: ${record.createdAt}`);
    console.log('\n📋【发给客服的开箱启动指令】(直接发给客服即可):');
    console.log('------------------------------------------------------------------------');
    console.log(`方式 A (开箱向导，推荐):`);
    console.log(`  双击桌面【小康TUI-智能排障助手】快捷方式，在弹出的首次激活窗口中粘贴此 Key 即可自动永久绑定。`);
    console.log(`\n方式 B (命令行参数快速启动):`);
    console.log(`  xhang -t ${record.token}`);
    console.log('------------------------------------------------------------------------\n');
    break;
  }

  case 'list': {
    const list = manager.listTokens();
    console.log('\n===================================================================================================');
    console.log(`📊 当前已分发的客服 Key 列表 (共 ${list.length} 个):`);
    console.log('===================================================================================================');
    console.log('| 员工姓名        | 访问令牌 (Key)         | 状态  | 绑定设备指纹 (1Key1机)             | 最近使用时间       |');
    console.log('| :-------------- | :--------------------- | :--- | :--------------------------------- | :----------------- |');
    for (const r of list) {
      const statusStr = r.enabled ? '🟢 启用' : '🔴 禁用';
      const deviceStr = r.boundDeviceId ? `🔒 ${r.boundDeviceId.slice(0, 32)}` : '⚪ 待激活(未绑定)';
      const lastTime = r.lastUsedAt ? r.lastUsedAt.slice(0, 19).replace('T', ' ') : '未使用';
      console.log(
        `| ${r.name.padEnd(14)} | ${r.token.padEnd(22)} | ${statusStr} | ${deviceStr.padEnd(34)} | ${lastTime.padEnd(17)} |`
      );
    }
    console.log('===================================================================================================\n');
    break;
  }

  case 'unbind': {
    const token = args[1]?.trim();
    if (!token) {
      console.error('❌ 错误: 请指定要解绑的 Token');
      process.exit(1);
    }
    const res = manager.unbindDevice(token);
    if (res.success) {
      console.log(`\n✅ ${res.message}\n`);
    } else {
      console.error(`\n❌ ${res.message}\n`);
    }
    break;
  }

  case 'enable': {
    const token = args[1]?.trim();
    if (!token) {
      console.error('❌ 错误: 请指定 Token');
      process.exit(1);
    }
    const res = manager.setTokenStatus(token, true);
    console.log(`\n✅ ${res.message}\n`);
    break;
  }

  case 'disable': {
    const token = args[1]?.trim();
    if (!token) {
      console.error('❌ 错误: 请指定 Token');
      process.exit(1);
    }
    const res = manager.setTokenStatus(token, false);
    console.log(`\n✅ ${res.message}\n`);
    break;
  }

  case 'delete': {
    const token = args[1]?.trim();
    if (!token) {
      console.error('❌ 错误: 请指定 Token');
      process.exit(1);
    }
    const ok = manager.deleteToken(token);
    if (ok) {
      console.log(`\n✅ 已彻底删除 Token: ${token}\n`);
    } else {
      console.error(`\n❌ 未找到 Token: ${token}\n`);
    }
    break;
  }

  default:
    printHelp();
    break;
}
