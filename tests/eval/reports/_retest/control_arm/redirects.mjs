// 对照组（改动前）要换掉的源码文件：原文件 → 改动前的原样副本，以及副本应有的 sha256。
// 副本来源（2026-10-17 用本会话转录逐次重放核对，见 replay_edits.mjs）：
//   review.ts       G3C 消融开跑时（2026-10-16T16:14:56Z）的版本 = 当前文件撤销 10-16 18:14 的 4 次 (C) 改动，哈希与 G3C manifest 一致
//   code_search.ts  HEAD f19ec9a 的版本 = 当前文件撤销 10-16 18:10~18:35 的 10 次 (A)(B) 改动（期间无其他改动）
//   tools/index.ts  HEAD f19ec9a 的版本 = 撤销 offset 参数描述那 1 次 (B) 改动
// core.ts 不换：改动前后只差 passed 择优分支，而 passed 只由新版 review.ts 的 (C) 分支产生，对照组走不到（运行器另有 passedSeen 计数自证）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
export const CONTROL_REDIRECTS = [
  { original: 'server/src/agent/review.ts', copy: 'tests/eval/reports/_retest/head_copies/review.g3c.ts', sha256: '01d65050c25d5fd2cef88f794c24bbfc04ff587ff78341ba05db04dddc261b2a' },
  { original: 'server/src/tools/code_search.ts', copy: 'tests/eval/reports/_retest/head_copies/code_search.head.ts', sha256: 'ac5048dbd8402a8f664d95c44b55de1d13314992adc5bd2c0acf5904ab8a6150' },
  { original: 'server/src/tools/index.ts', copy: 'tests/eval/reports/_retest/head_copies/index.head.ts', sha256: 'e9b1fc54cc33c03ecf642616223f6b8c0acb117bcfadd5f5f42198386df41f4d' },
];
