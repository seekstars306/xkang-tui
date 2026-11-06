# 08 · G3 四项实验与 Phase 3（R1–R3）执行模型实操指南

> **前置状态**：`accuracy-v3` 分支已完成 Phase 0、Phase 1、Phase 2 代码层、Phase 4 全部代码及 R4/R5，267 项单测与 3 项类型检查全绿。
> **用户已拍板批准**：
> 1. **G3 预算已批准**：允许按串行顺序执行 `S7 → S3 → M2 → M3` 四项实验（预算上限合计 ≈4.4M token，单任务超 10M 停机请示，每次调用必写 `tests/eval/reports/exec-v3/usage-ledger.jsonl`）。
> 2. **G5 三份设计文档（`designs/D1–D3`）已批准**，待拍板项正式定稿如下：
>    - **D1（R1 部分发布）**：`claims` 由服务端在 `parsePublicDraft` 之后从复核报告逐块裁决生成（不塞进 `draftSchema`）；前端与现有 `businessData` 并存渲染；**M3 实验完成前严禁修改 `review.ts` 提示词**。
>    - **D2（R2 预算与冻结）**：15 分钟到点安全点冻结，同时展示 `frozenAnswer`（已核实内容）+ 明确提示可追加 5 分钟；人工不限次数追加 5 分钟，底层受 `turnsAllowed <= 200`、`reviewAttemptsAllowed <= 10` 硬上限保护。
>    - **D3（V4 数据核对模式）**：`DATA_ONLY_FOR_UNKNOWN` 保持默认 `false`（待 G6 部署清单到位后再打开）；`git_inspect show` 保持现状。

---

## 1. 本轮执行顺序（严格串行，不可颠倒）

**本轮做完后，执行轮 1 的全部代码开发与基准实验即 100% 收官（仅剩 Phase 5 等待客服工单导出 G7）。**

```
Step 1 (G3 实验，严格串行，先拿干净实验结论，期间严禁改 review.ts 提示词):
  1.1 S7 受控检出率回归 (18 条虚构用例 × 2 轮)
  1.2 S3 提示词回归 (20 题 evidence 模式 × 1 变体 flash-high)
  1.3 M2 复核基准基线 (23 条用例 × 2 轮 → 产出 baseline.json)
  1.4 M3 复核思考档位实验 (default / low / high × 23 条 × 2 轮 → 选定档位)

Step 2 (Phase 3 剩余三项工程落地，在 M3 完成之后执行):
  2.1 R1 按断言粒度部分发布 + M2 基准回归验证
  2.2 R2 15 分钟活跃预算、安全点冻结与不限次 +5 分钟续查
  2.3 R3 Web UI 与 TUI 续查交互与部分发布渲染
```

---

## 2. Step 1：G3 四项实验实操细则

**通用铁律**：
- 全部**串行**执行（并发设为 1，避免污染 P50/P90 时延数据）；
- 每次模型调用必须通过 `appendUsageLedger` 写入 `tests/eval/reports/exec-v3/usage-ledger.jsonl`（带 `task: 'S7' | 'S3' | 'M2' | 'M3'`）；
- 每次调用必须有单次超时保护；
- 产物统一落 `tests/eval/reports/exec-v3/<任务号>-<日期>/`，写 `manifest.json`（含源码 commit、是否有未提交改动、模型名、`reasoning_effort`、超时配置、输入哈希）。

### 1.1 `S7` 受控检出率回归
- 使用 `scripts/eval/review_optimization.ts` 的 18 条虚构受控用例（`origin === 'fictional'`），串行跑 2 轮；
- 核对检出率（`expected=false` 被拦）与误拦率（`expected=true` 被拦）不劣于 S7 变更前记录（35/36）；
- 结果写入 `tests/eval/reports/exec-v3/s7-regression/` 并更新 `STATUS.md`。

### 1.2 `S3` 提示词修正回归
- 使用 `scripts/eval/model_ceiling.ts` 的 `evidence` 模式，只跑单变体 `flash-high`（20 题 × 1 轮，并发 1）；
- 与 `tests/eval/reports/model-ceiling-20261009/evidence/` 同变体结果对比关键结论命中数（此前为 17/20），确认删去无效工具与修正出处要求后关键结论不下降；
- 若出现下降，按 `20-phase1-quick.md` S3 预案定位原因并记录到 `STATUS.md`。

### 1.3 `M2` 复核基准基线（`baseline.json`）
- 使用 `scripts/eval/review_benchmark_cases.ts` 全部 23 条用例（18 条虚构 + 5 条脱敏真实案例），串行跑 2 轮（共 46 次复核）；
- 产出 `tests/eval/reports/exec-v3/m2-baseline/manifest.json` 与 `baseline.json`（记录总条数、分类分布、检出率、误拦率、耗时 P50/P90、总 token）。

### 1.4 `M3` 复核思考档位实验（定下档位后才允许进入 Step 2）
- 在 M2 的 23 条基准上，分別以 `REVIEW_REASONING_EFFORT=default`、`low`、`high` 三组串行各跑 2 轮（共 138 次复核）；
- 产出对比表（四类指标分开报：检出率、误拦率、P50/P90 耗时、输入/输出/思考/缓存 token）；
- 按 `30-phase2-attribution-benchmark.md` M3 规则选定档位，写入 `server/.env.example`、`tests/eval/reports/exec-v3/m3-effort-report.md` 与 `STATUS.md`。

---

## 3. Step 2：Phase 3（R1 / R2 / R3）实操规格与避坑指令

> **前提确认**：进入本步骤前，确认 `M3` 已完成且 `baseline.json` 已落盘。

### 2.1 `R1` 部分发布（按 `designs/D1-partial-publish.md` 实现）
1. **DTO 扩展（`packages/agent-core/src/public.ts` & `src/adapters/business_client.ts`）**：
   - 在 `PublicAnswer` 新增可选字段：
     ```ts
     export interface PublicClaim {
       text: string;
       status: 'confirmed' | 'pending';
       conditions?: string[];
       exceptions?: string[];
       evidenceRefs?: string[];
     }
     ```
     并在 `PublicAnswer` 上加 `claims?: PublicClaim[]`；
   - **【避坑】** 同步更新 `src/adapters/business_client.ts` 的 `publicAnswer(value)`：当 `Array.isArray(value.claims)` 时保留并校验 `claims`，避免客户端适配器把 `claims` 静默丢掉！
2. **复核与服务端拼装（`server/src/agent/review.ts` & `server/src/agent/service.ts`）**：
   - **红线**：`record.challenge.issues` 点名的 `blockId` **一律判为 `pending`**，绝不允许成为 `confirmed`；
   - 当 `features.partialPublish` 为 `false`（默认）时，`reviewAnswer` 与 `service.ts` 行为与基线 **100% 逐字节一致**（不附加 `claims`，部分保留仍按旧逻辑）；
   - 当 `features.partialPublish` 为 `true` 时：
     - 即使 challenge 有部分问题或引文阶段部分块未通过，只要存在至少一条无 challenge 问题、引文校验通过（`supported` 且引文真实有效）的块，即可构造部分发布答案；
     - `claims` 在 `parsePublicDraft` 校验通过**之后**拼装到 `PublicAnswer` 上（绝不塞进 `.strict()` 的 `draftSchema`）；
     - 未通过核实的块转入 `pendingItems` 与 `claims`（`status: 'pending'`），已通过的块标为 `status: 'confirmed'` 并附带 `evidenceRefs`。
3. **测试与回归**：
   - 先写 `tests/server/partial_publish.test.ts` 覆盖 4 种组合（两阶段全过、反证点名某条、引文某条失败、两阶段全败）+ 开关关闭时的基线一致性；
   - 在开启 `partialPublish` 下跑一次 M2 基准回归，确认 `expected=false` 的错误断言检出率不下降。

### 2.2 `R2` 15 分钟预算、冻结与续查（按 `designs/D2-time-budget-freeze.md` 实现）
1. **`AgentCore` 预算与 `RunState`（`packages/agent-core/src/core.ts`）**：
   - `AgentOptions` 增加可选 `budget?: { activeMs?: number; extensions?: number; turnsPerExtension?: number; reviewsPerExtension?: number }` 及 `initialRunState?: Partial<RunState>`、`onStateChange?: (state: RunState) => void`；
   - 默认值：`activeMs = 15 * 60 * 1000`、`extensions = 0`、`turnsPerExtension = 10`、`reviewsPerExtension = 1`；
   - 公式：`turnsAllowed = Math.min(200, 50 + turnsPerExtension * extensions)`，`reviewAttemptsAllowed = Math.min(10, 2 + reviewsPerExtension * extensions)`；
   - **被截止时间（deadline）取消的复核不消耗 `reviewAttempts` 配额**，记为 `aborted_by_deadline`；
   - 在每次工具/模型调用之间的安全点检查活跃耗时是否达到窗口上限：到点且 `features.timeBudget` 开启时，进入冻结收尾（保存 `RunState` 与当前已核实内容 `frozenAnswer`）。
   - **【避坑】** 本地 `--local` 模式（未传 `budget` 或未开启 `timeBudget`）的行为必须完全不变，跑通 `tests/client/**` 全部用例。
2. **持久化与 `service.get()` 保护（`server/src/agent/store.ts` & `server/src/agent/service.ts`）**：
   - `store.ts` 照 `PRAGMA table_info(agent_sessions)` 模式按需 `ALTER TABLE` 增加 `run_state TEXT`、`frozen_answer TEXT`；
   - `service.get()`：当会话无活动运行但 `run_state` 标记为 `frozen: true` 时，**严禁将其擦除为 `unavailableAnswer`**，保留其 `frozen: true`、`extensions`、`frozenAnswer` 等可选字段返回给客户端；
   - **【避坑：线缆 `status` 铁律】**：`PublicSession.status` 只能是 `'idle' | 'running' | 'waiting_question'` 三个值之一（冻结时线缆 `status` 设为 `'idle'`，同时通过 `PublicSession` 的可选字段 `frozen?: boolean; extensions?: number; activeElapsedMs?: number; activeBudgetMs?: number` 表达冻结态），同步在 `src/adapters/business_client.ts` 的 `publicSession()` 中透传这些可选字段！
3. **续查接口（`server/src/agent/routes.ts` & `server/src/agent/service.ts`）**：
   - 新增 `POST /agent/sessions/:id/continue`（员工鉴权）：`extensions += 1`，重置 5 分钟活跃窗口，从已保存的 `messages` 与 `RunState` 恢复运行（支持 SSE 或返回状态后轮询，重复点击幂等）。
4. **单测**：新建 `tests/server/time_budget.test.ts`（用 mock timers 测齐 6 项断言：15 分钟到点冻结保留已核实内容、追加 1 次配额增加、追加 20 次受 200/10 硬上限约束、截止取消复核不扣配额、冻结后 `service.get()` 不擦除、序列化 `status` 仍为 3 个合法值之一）。

### 2.3 `R3` 接口与界面（Web UI + TUI）
1. **修改前先跑基线**：先运行 `npm run test:ui`、`npm run test:ui:sessions` 存档基线。
2. **双端解析器同步（`src/utils/answer_verdict.ts` + `web/answer.js`）**：
   - 两份文件必须同步支持 `claims`（`confirmed` / `pending`）的格式化或辅助渲染，确保 `tests/client/answer_format.test.ts` 交叉校验通过。
3. **Web UI（`web/app.js` & `src/business_web_server.ts`）**：
   - 按 `/config/client` 下发的 `features.timeBudget` 控制是否展示预算进度（`已用 X 分 / 上限 15 分`）与冻结后的“继续排查 5 分钟（第 N 次追加）”按钮；
   - **【避坑 1】** `web/app.js` 的 `finalizeTurn`（第 996 行）会禁用 `.gate` 下所有按钮，因此“继续 5 分钟”按钮应放在 `addAnswerFooter` 或独立于 `.gate` 的容器中；
   - **【避坑 2】** `.answer-foot .foot-btn` 的**第一个按钮必须始终是“复制回答”**（`tests/ui/web_ui_snapshots.mjs` 第 28 行依赖第一个按钮是复制！）；
   - `handleEvent` 第 1430 行的业务模式事件白名单同步放行新增的进度/冻结事件字段。
4. **TUI（`src/tui/BusinessApp.tsx` & `src/adapters/business_client.ts`）**：
   - `BusinessClient` 新增 `continue(id: string)` 方法；
   - `BusinessApp.tsx` 支持 `/continue` 命令，并在 `session?.frozen` 为真时显示提示：“已达 15 分钟上限（已保留已核实内容），输入 /continue 追加 5 分钟继续排查”。

---

## 4. 收尾验收清单

1. `npm test`、`npm run typecheck`、`npm run typecheck:test`、`cd server && npx tsc --noEmit`、`npm run test:ui`、`npm run test:ui:sessions` 全部通过。
2. `tests/eval/reports/exec-v3/usage-ledger.jsonl` 中完整记录了 `S7`、`S3`、`M2`、`M3`（及 `R1` 基准回归）的 token 账目，总消耗在批准预算内。
3. 更新 `STATUS.md`（填写 Phase 2、Phase 3、Phase 4 阶段报告三句话摘要）与 `memory/memory.md`，提交完整报告 `tests/eval/reports/exec-v3/report-phase3.md` 与 `report-phase4.md`。
