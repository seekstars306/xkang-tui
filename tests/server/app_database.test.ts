import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppDatabase } from '../../server/src/db.ts';
import { ActiveModelManager } from '../../server/src/model_state.ts';

test('legacy model is imported once and does not overwrite an admin selection on restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-model-migration-'));
  const dataDir = path.join(root, 'data');
  fs.writeFileSync(path.join(root, 'active_model.json'), JSON.stringify({ activeModel: 'auto' }));
  let appDb: AppDatabase | undefined;
  try {
    appDb = new AppDatabase({ dataDir });
    const manager = new ActiveModelManager(appDb.db);
    assert.equal(manager.getActive(), 'auto');
    manager.setActive('deepseek');
    const selected = appDb.db.prepare("SELECT value, updated_at FROM sys_configs WHERE key = 'active_model'").get();
    appDb.db.close();
    appDb = undefined;

    appDb = new AppDatabase({ dataDir });
    assert.equal(new ActiveModelManager(appDb.db).getActive(), 'deepseek');
    assert.deepEqual(appDb.db.prepare("SELECT value, updated_at FROM sys_configs WHERE key = 'active_model'").get(), selected);
  } finally {
    appDb?.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
