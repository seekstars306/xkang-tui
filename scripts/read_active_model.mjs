import {DatabaseSync} from 'node:sqlite';
const dbPath = process.argv[2];
if (!dbPath) { console.error('用法: node scripts/read_active_model.mjs <db 路径>'); process.exit(2); }
try {
  const db = new DatabaseSync(dbPath, {readOnly: true});
  const row = db.prepare("SELECT value FROM sys_configs WHERE key='active_model'").get();
  db.close();
  process.stdout.write(String(row?.value ?? ''));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(3);
}