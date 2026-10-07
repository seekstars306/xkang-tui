import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const dbPath = process.argv[2] || "./server/data/xkang.db";
const sql = process.argv[3];

if (!fs.existsSync(dbPath)) {
  console.error(`❌ 数据库文件不存在: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

if (!sql) {
  console.log(`\n📂 当前 SQLite 数据库: ${path.resolve(dbPath)}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("\n📋 表列表与数据统计:");
  for (const t of tables) {
    if (t.name.startsWith("sqlite_")) continue;
    const count = db.prepare(`SELECT count(*) as c FROM ${t.name}`).get();
    console.log(`  - 表名: \x1b[36m${t.name}\x1b[0m (行数: ${count.c})`);
  }
  console.log("\n💡 用法示例:");
  console.log("  node scripts/db.mjs ./server/data/xkang.db \"SELECT * FROM auth_tokens;\"");
  console.log("  node scripts/db.mjs ./server/data/xkang.db \"SELECT * FROM sys_configs;\"\n");
  process.exit(0);
}

try {
  if (sql.trim().toUpperCase().startsWith("SELECT") || sql.trim().toUpperCase().startsWith("PRAGMA") || sql.trim().toUpperCase().startsWith("EXPLAIN")) {
    const rows = db.prepare(sql).all();
    console.log(`\n🔍 查询结果 (${rows.length} 行):`);
    console.table(rows);
  } else {
    const info = db.prepare(sql).run();
    console.log(`\n✅ 执行成功: changes=${info.changes}, lastInsertRowid=${info.lastInsertRowid}`);
  }
} catch (err) {
  console.error("❌ SQL 执行失败:", err.message);
}
