# Phase 3 · 复核与交付重构

前置：Phase 1 全部完成；**M2 与 M3 已完成**（尤其 M3——本阶段会改复核提示词，必须在档位定下来之后）。

> **发布门禁提醒**：`scripts/eval/release_gate.mjs` 会哈希冻结一批源文件——`packages/agent-core/src/**`、`server/src/agent/{model,review,publication,investigation_prompt}.ts`、`server/src/tools/**`、`server/src/{llm,model_state,system_prompt,skills,mcp}.ts`、`src/{mcp/client,tools/registry}.ts`，`BUSINESS_PROMPT` 单独哈希。本阶段**每一处改动都会让已有的验收报告失效**，将来要发布必须重新跑一轮验收并出新报告。本轮不发布，所以只需在 `STATUS.md` 记一笔。

---

## R1 部分发布：按"断言 + 条件 + 例外 + 证据"粒度

**目标**：不再"要么全发、要么整体降级"，改成**逐条断言**发布：每条标成"已确认"或"待核实"，已确认的必须带适用条件与证据。

**依据**
- 现状：只有两阶段全过才给 `reviewStatus='reviewed'`；部分保留**只在引文阶段失败时生效**，而且保留单位是整个 `businessData` / `evidenceSummary` 条目（`review.ts` 约 179–190 行）。反证失败、超时、格式失败一律整体作废。
- 代价：一次接受验收里 60 次运行有 11 次降级，其中 7 次是复核 JSON 不合规造成的——**格式问题就让整题作废是不合理的**。
- 主要错误形态是"适用范围说大"（M1 会给出确切比例），所以发布结构必须**按条件切分**，而不是按字段切分。

**改动点**
1. `packages/agent-core/src/public.ts`：`PublicAnswer` **新增可选字段**，例如
   `claims?: Array<{ text: string; status: 'confirmed' | 'pending'; conditions?: string[]; exceptions?: string[]; evidenceRefs?: string[] }>`。
   旧字段一律保留（客户端兼容）。
2. **新增字段必须在严格校验之后拼上去**。`server/src/agent/service.ts` 约 131–134 行的写法是
   `const { reviewStatus, traceId, ...draft } = parsed; const validated = parsePublicDraft(JSON.stringify(draft), …); answer = { ...validated, reviewStatus, traceId };`
   ——任何**在 `parsePublicDraft` 之前**多出来的字段都会在 `draftSchema` 的严格校验里被拒，而那个异常会被一个静默 catch 吞掉。所以新字段只能加在后面，或者明确加进 `draftSchema`。
3. `server/src/agent/publication.ts`：`draftSchema` 保持严格；新增字段要么进 schema，要么在 schema 之外拼装。`PRIVATE_PATTERNS` **不动**。
4. `server/src/agent/review.ts`：把引文阶段的裁决从"整条 `businessData` 一刀切"改成**每条断言一条裁决**。复核输出结构随之调整 → 提示词要改。
5. `server/src/agent/service.ts`：组装公开答案时，把 `confirmed` 与 `pending` 分开；`pending` 项连同"已查到的事实"一起展示，措辞固定为待核实。

**红线（不许为了覆盖率而违反）**
- **反证阶段点名的问题一律进"待核实"**，不得因为"总体通过"而放行。M2 基准里 `expected=false` 的用例必须继续全部被拦。
- 部分发布**不得**降低严重误导的门槛；D5 的"严重误导为 0"不变。
- 公开答案里不得出现表名、字段名、SQL、源码路径、内部地址（`PRIVATE_PATTERNS` 照旧）。

**步骤**
1. 先写测试（`tests/server/partial_publish.test.ts`），四种组合都要覆盖：
   - 两阶段全过 → 全部 `confirmed`；
   - 反证点名其中一条 → 该条 `pending`，其余 `confirmed`；
   - 引文阶段某条失败 → 该条 `pending`，其余 `confirmed`；
   - 两阶段都失败 → 全部 `pending`，且**仍有已核实事实**可展示（不是空兜底）。
2. 改提示词与结构，跑到测试过。
3. 用 M2 基准回归：检出率不得下降（`expected=false` 仍要全拦）。**要花钱，先报预算。**
4. `npm test`、三项类型检查全绿后提交。

**验收**：四种组合测试通过；M2 基准检出率不下降；公开答案里 `pending` 项**不含**任何被写成"已确认"的条件性断言。

**依赖**：M2、M3。

**关口**：G3（基准回归费用）、G5（设计文档批准——部分发布的公开结构要用户先点头）。

**风险与回滚**：整体兜底拆开后，可能让一句错误断言以"已确认"发出去。所以：断言级测试 + M2 回归 + 特性开关（R5）三者缺一不可；开关默认关。

---

## R2 15 分钟预算、冻结与续查（不限次数追加 5 分钟）

**目标**：单题活跃 15 分钟封顶；到点**在安全点冻结**并保留已核实内容；人工可以**不限次数**追加 5 分钟（决策 D1）。

**依据**
- `packages/agent-core/src/core.ts` 的 `run()`：轮数、协议错、空回复、复核次数、动作重试、补查配额**全部是局部变量**，外部无法观察也无法扩展。`mustSummarize = turns >= 50 || repairRemaining === 0`；`repairRemaining = Math.min(3, Math.max(0, 50 - turns))`。
- 20 秒工具超时只 reject 不取消（约第 165 行），被超时的工具在后台继续跑。
- 实测时间构成：复核占 53%，排查 29%，草稿 9%，修订 7% → **只延长墙钟而不延长配额是没用的**，必须同时给出可用的轮次与复核次数。

**设计（这是本计划里唯一需要明确拍板的设计点，照此实现）**
- `run()` 接受一个 `budget`：
  `{ activeMs, extensions, turnsPerExtension, reviewsPerExtension }`，默认 `{ activeMs: 15*60*1000, extensions: 0, turnsPerExtension: 10, reviewsPerExtension: 1 }`。
- `turnsAllowed = 50 + turnsPerExtension * extensions`，**硬上限 200**；
  `reviewAttemptsAllowed = 2 + reviewsPerExtension * extensions`，**硬上限 10**。硬上限是防止自动续查或误操作把费用打飞。
- **被截止时间取消的复核不消耗复核配额**，记为 `aborted_by_deadline` 并在下一条 `ReviewStatus` 里体现。
- 冻结**只在两次调用之间**发生（安全点）；冻结时把已核实内容持久化。
- 追加 5 分钟 = `extensions += 1`，同时把 `activeMs` 重置为 5 分钟窗口。**不限次数**，但每次都要有人明确触发。

**改动点**
1. `packages/agent-core/src/core.ts`：把局部计数器收进一个 `RunState` 对象（可在 `run()` 内，也可挂在返回的句柄上），按 `budget` 计算上限；`abort` 后要在有限步数内退出。**所有新参数必须有默认值**，本地 `--local` 模式（`src/harness/agent.ts` 继承 `AgentCore`）行为必须完全不变。
2. `server/src/agent/store.ts`：冻结状态要能持久化；`agent_sessions` 只有 `public_json` 与 `private_json` 两列、每次整份重写，**没有 status 或 run-state 列**。加列请照 `db.ts` 约 51–52 行的先例：`PRAGMA table_info` 检查后再 `ALTER TABLE`。**不要引入迁移框架。** `transaction()` 不可重入，别嵌套。
3. `server/src/agent/service.ts`：`get()` 现在会把"非 idle 且无活动运行"的会话**重置为 idle 并编造 `unavailableAnswer`** —— 这会把持久化的冻结状态擦掉，**必须改**。
4. 接口：
   - 续查用**新增**的 `POST /agent/sessions/:id/continue`，**不要复用** `POST /agent/sessions/:id/messages`（后者是 SSE，含 15 秒心跳、以 `done` 结束，服务端的既有测试依赖这个行为）。
   - **线缆上的 `status` 不得新增取值**。已核实：`bclient.ts` 第 15 行遇到未知 status 会抛，而 `list()`（bclient 第 34 行）没有逐项容错 → **一个"冻结"会话会让整个 `/api/sessions` 返回 503**。所以冻结/可续查放进**可选字段**，并用 `GET /config/client` 的 `businessApiVersion` 做能力协商。
   - 注意：客户端**从来不 gate 版本号**，而且 `businessApiVersion: 1` 被 `tests/helpers/business_fixture.ts` 与 `tests/integration/real_systems.it.test.ts` 钉住 → 改它的语义要同步改这两处测试。
5. 运行级取消用**已经存在但从未被接上**的 `runSignal`（`BusinessModel` 构造函数第 5 个参数，`service.ts` 第 100 行附近没传）。**不要**改用 `options.signal`——它现在的语义是"这是一次复核调用"，测试替身（`tests/helpers/business_fixture.ts` 第 32 行、`tests/server/agent_privacy.test.ts` 第 29 行）靠它分流。

**步骤**
1. 先写测试（`tests/server/time_budget.test.ts`），用现有的 mock timers（问题定时器与复核超时已经能用它测）：
   - 15 分钟到点 → 冻结，已核实内容仍在；
   - 追加一次 → `turnsAllowed` 与 `reviewAttemptsAllowed` 按设计增加；追加 20 次 → 仍被硬上限挡住；
   - 被截止时间取消的复核 → 不消耗配额；
   - 冻结后调用 `service.get()` → 冻结状态**没有**被擦成 idle；
   - 序列化后的会话对象里 `status` 仍只有 `idle`/`running`/`waiting_question` 三个值。
2. 改实现，跑到测试过。
3. 回归本地模式：跑 `npm test`，确认 `tests/client/**` 与本地 harness 相关用例不回归（`AgentCore` 是共用的，这是本轮最容易伤到的地方）。
4. 提交。

**验收**：六项测试通过；`npm test` 174 项全绿；本地模式行为无变化；线缆 status 取值集合未变。

**依赖**：S4（取消与时限）、R1（冻结时要保留"已核实内容"，依赖部分发布的结构）。

**关口**：G5（设计文档批准）、G9（生产启用要重启）。

**风险与回滚**：`packages/agent-core` 与服务端业务路径、本地 `--local` 模式共用。风险最高的一处。回滚靠特性开关（R5）+ 默认参数（`extensions: 0` 时行为与基线一致）。

---

## R3 接口与界面

**目标**：客服能看见"已用多久、还剩多久"，到点后能点"继续 5 分钟"。

**依据（已核实的界面事实）**
- `web/app.js` 的 `finalizeTurn`（约第 995–1001 行）会**禁用所有 `.gate`** → 续查按钮放在 `.gate` 里到点就没法点。
- `tests/ui/web_ui_snapshots.mjs` 第 28 行会把 `.answer-foot .foot-btn` 的**第一个**当作"复制"来点 → **复制按钮必须留在第一位**。
- 业务模式的 `handleEvent` 有一份事件白名单（约第 1429 行），新事件类型要被放行。
- TUI 的 `submit` 在会话 running 时**提前返回** → 需要加 `/continue` 命令。
- `src/utils/answer_verdict.ts` 与 `web/answer.js` 是**同一份解析器的两份实现**，`tests/client/answer_format.test.ts` 会交叉校验 → **必须同时改**。

**改动点**
1. `web/app.js`：续查控件放在 `addAnswerFooter`（约第 973–982 行），或在 `finalizeTurn` 里显式豁免它。**复制按钮保持在最前。**
2. 进度显示：明确写出"已用 X 分 / 上限 15 分"；到点后按钮变"继续 5 分钟"，并显示这是第几次追加。不要只用一个没有文字说明的进度条。
3. 按 `GET /config/client` 的 **feature 白名单**决定是否显示续查控件（不要按版本号硬判）。
4. `handleEvent` 白名单放行 `frozen` / `budget` 之类的**新事件类型**（注意：是事件类型，不是会话 status）。
5. `src/tui/BusinessApp.tsx`：加 `/continue` 命令，并在会话冻结时给出提示。
6. `src/utils/answer_verdict.ts` + `web/answer.js`：同步支持 `claims` 的 `confirmed` / `pending` 渲染。
7. `tests/ui/web_ui_demo_data.ts` 与相关快照要跟着更新。

**步骤**
1. **先跑一遍基线**：`npm run test:ui`、`npm run test:ui:sessions`，把结果存档，避免"本来是红的"被误当成自己改坏。
2. 改前端与 TUI。
3. 跑 `npm run test:ui`、`test:ui:sessions`、`test:ui:live`（live 用隔离实例）。注意 `test:ui:live` 的预览面板太窄，以 `tests/ui/` 下的脚本输出为准。
4. 手工在隔离实例上看一次冻结与续查的实际表现（真实数据截图可能含 PII，只能存 git 忽略目录）。
5. 提交。

**验收**：三个 UI 测试全绿；快照差异全部可解释（复制按钮仍在第一）；冻结后按钮可点，点击后服务端收到 `continue` 且会话继续。

**依赖**：R2（接口先定）。

**关口**：G9。

**风险与回滚**：改前端会动既有快照 → 先存档基线结果再改（第 1 步）。UI 不可用时服务端功能不受影响（开关关掉即回到旧界面）。

---

## R4 反馈绑定到回合与答案（并去掉凭据与全量上下文）

**目标**：客服点"回答有误"时，能精确定位到**哪一回合、哪个答案**；同时不再把原始凭据和整份会话上下文写进库。

**依据（已核实）**
- 前端"回答有误"调用 `openFeedback()`，**忽略点的是哪张卡片**。
- `POST /api/feedback` 往 `cs_feedbacks` 存**原始 bearer token**（列 `user_token`）和**整份私有 `Message[]`**（列 `context`）。
- **没有 turn id / answer id**。
- 这条链路**没有任何测试**。
- 回合 id 在 `handleEvent` 和 `browserSession` 重放时都会被丢掉。
- 公开回合 id 形如 `r_<uuid>` 且**等于 `answer.traceId`**；core 私有的 `turnId` 形如 `t_<uuid>`，**两者之间没有任何连接**。

**改动点**
1. **建立公开 id 与私有记录的连接**（二选一，写清理由）：
   - 在写私有消息时把公开回合 id 一并存进去；或
   - 在 `PublicAnswer` 上补回 `traceId`。
   选完要在 `STATUS.md` 写一句为什么。
2. 前端：按钮带上被点卡片的回合 id；`handleEvent` 与 `browserSession` 不再丢 turn id。
3. 服务端 `POST /api/feedback`：
   - `cs_feedbacks` 加列 `turn_id`、`answer_id`、`verdict`（照 `db.ts` 51–52 行先例，**加列不改列**，保证存量数据兼容）；
   - `user_token` 改成**令牌的稳定哈希**或直接用员工 `subjectId`（去重与溯源够用即可），**不再存令牌原文**；
   - `context` 改成**只存被反馈的那一轮**，且先过脱敏（S6 的 `input_guard` 可复用）；不要存整份私有消息。
4. 配额与去重：同一回合重复反馈只记一次。

**步骤**
1. 先写测试（这条链路**目前一条测试都没有**）：反馈落库后能按 turn id 查回原始答案；库里搜不到 bearer 原文；`context` 只含一轮且不含凭据形态。
2. 改前端 + 服务端。
3. 查一下生产库 `cs_feedbacks` 的存量数据形态（**只读**），确认加列后旧数据仍能读。
4. 提交。

**验收**：三项测试通过；隔离实例里发一次真实反馈，库里能查回 turn id，且搜不到原始令牌。

**依赖**：S6（脱敏函数复用）。

**关口**：G9。

**风险与回滚**：改表结构要先确认存量数据能兼容（加列而不是改列）。若 `cs_feedbacks` 存量里 `user_token` 已有真实令牌，**这件事本身要写进 T0.4 的凭据暴露报告**——反馈表里有明文令牌，等于凭据落库。

---

## R5 特性开关与灰度

**目标**：本阶段所有新行为**默认关闭**，用环境变量打开，能在不重新构建的情况下回滚。

**改动点**
1. `server/src/config.ts` 新增开关（默认全 `false`）：
   `FEATURE_PARTIAL_PUBLISH`、`FEATURE_TIME_BUDGET`、`FEATURE_INPUT_GUARD`、`FEATURE_FEEDBACK_BINDING`。
2. `GET /config/client` 的返回里增加 `features: { … }`（**保留现有字段的语义不变**，`businessApiVersion: 1` 被两处测试钉住）。
3. 客户端按 `features` 决定是否显示续查控件，不再靠版本号硬判。
4. 每个开关都要有"开"和"关"两条路径的测试；**关掉时行为必须与基线逐字节一致**（尤其是公开答案结构）。

**步骤**
1. 先写开关测试。
2. 接进各功能，确认关掉后 `npm test` 全绿。
3. `STATUS.md` 记录四个开关的默认值与打开条件。
4. 提交。

**验收**：开关默认全关；关掉后行为与基线一致；`/config/client` 的既有字段没有变化。

**依赖**：R1–R4。

**关口**：**G9**（在运行中的服务端打开开关需要重启）。

**风险与回滚**：开关本身是回滚手段，所以它必须在功能之前落地（顺序：先做 R5 的骨架，再做 R1–R4）。
