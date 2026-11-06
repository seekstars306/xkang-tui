# 07 · Phase 2–4 执行模型实操指南与避坑清单

> **前置状态**：`accuracy-v3` 分支已完成 Phase 0（T0.1–T0.5）与 Phase 1（S1–S9），229 项单测与 3 项类型检查全绿（2026-10-15 经独立复跑复核）。
> **本文件用途**：指导执行模型推进 **Phase 2、Phase 3、Phase 4 中所有零模型费用任务与前置工程准备**，并明确需要停下等待 **G3（Token 预算）/ G5（设计批准）/ G6（开发清单）** 的精确分界线。

---

## 1. 本轮任务全景：哪些立即做（零费用），哪些到点停（等关口）

| 批次 | 任务 | 是否调付费模型 | 执行策略 |
|---|---|---|---|
| **Batch 1** | **M1** 失败归因（扫描 + 归因表 + 20 条抽查包） | **否（零费用）** | **立即完整执行**（材料已在 `acceptance-verified/`） |
| **Batch 2** | **M4** 盲评与评分工具链（4 个脚本 + 样例验证 + 单测） | **否（零费用）** | **立即完整执行** |
| **Batch 3** | **M2 / M3 代码层准备**（抽离用例表、脱敏脚本、`reviewReasoningEffort` 配置与单测） | **否（零费用）** | **立即写好代码与单测**；真实跑模型（S3/S7/M2/M3 实验）停在 **关口 G3** 等批准 |
| **Batch 4** | **R5** 特性开关骨架 + **R4** 反馈绑定与脱敏 | **否（零费用）** | **立即完整执行**（R5 先于 R4） |
| **Batch 5** | **V1** 样例与校验器 + **V2** 三档判定 + **V3** 工具结果版本戳与图谱清单同步 + **V4** 运行起点固定与数据核对模式 | **否（零费用）** | **立即完整执行**（真实部署清单填充等 **G6**，代码、单测与基于现网只读状态的判定全部落地） |
| **Batch 6** | **G5 三份设计文档起草**（R1 部分发布 / R2 预算与冻结 / V4 数据核对） | **否（零费用）** | **立即起草文档**，提交用户审批（**关口 G5**）；**严禁在 M3 跑完前修改 `review.ts` 的提示词** |

---

## 2. 逐批次实操规格与代码级避坑指令

### Batch 1：M1 失败归因（`30-phase2-attribution-benchmark.md`）

1. **数据源精确坐标（已核实）**
   - 目录：`tests/eval/reports/server-harness-20261009/acceptance-verified/`
   - 评分汇总：`grades.json`（共 120 条：`baseline` 60 条、`candidate` 60 条；字段含 `variant`、`caseId`、`round`、`grade`、`usable`、`severeMisleading`、`rationale`、`artifacts.answer`、`artifacts.evidence`）。
   - 逐次运行目录：`<variant>-<caseId>-<round>/`（即 `run_id`），内含 `answer.txt`、`audit.json`、`messages.json`、`result.json`。
2. **要实现的脚本与产物**
   - `scripts/eval/scan_run_evidence.ts`：确定性扫描 120 个 `<run_id>/messages.json` 中 `role === 'tool'` 的工具原文（`content` 字段；该数据集没有 `raw_tool_result`，且 `content` 即模型实际读到的版本），输出布尔事实列：
     - `saw_excluded_path`：命中 `prod-config`、`\.bak(\.|$)`、`\.old\b`、`node_modules`；
     - `saw_duplicate_basename`：先扫描 `D:\skt_project\skt-back\skt_cxy` 与 `skt_dpxt_background` 算出同 basename 文件名集合（2527 个），检查工具结果是否读取/命中它们；
     - `saw_new_old_dir`：命中 `orderNew|invoiceNew|hotelNew|entityOld|[A-Za-z0-9_]+_old`；
     - `saw_historical_doc`：命中 `CODE_REVIEW_ISSUES\.md` 等问题记录文档；
     - `saw_dirty_mirror`：检查是否命中当时未提交改动文件。
   - `scripts/eval/build_attribution_sheet.ts`：结合 `grades.json`、扫描结果与各运行目录的复核/工具证据，生成并填充 `tests/eval/reports/exec-v3/attribution.tsv`（被 git 忽略）。
   - **归因纪律**：对所有失败运行（`usable === false`，尤其 candidate 的 38 条与 baseline 的 47 条）逐条归入类别 `1..7` 或 `U`；**凡填 `1..7` 的行必须给出精确的 `evidence_pointer`（如 `candidate-xxx-1/messages.json#msg[4](e_...)` 或 `result.json#review.issues`）**，拿不出指针一律填 `U`。
   - 产出汇总报告 `tests/eval/reports/exec-v3/m1-attribution-summary.md` 与 20 条抽查包 `tests/eval/reports/exec-v3/m1-dev-review-pack.md`（优先含 `severeMisleading=true` 与 `U` 类，触发 **关口 G2**）。

---

### Batch 2：M4 盲评与评分工具链（`30-phase2-attribution-benchmark.md`）

1. **在 `scripts/eval/` 下新建 4 个模块**
   - `make_blind_pack.ts`：输入同一题目/工单的多个候选答案，使用**带固定种子的确定性伪随机数生成器**（如 Mulberry32，在输出包头记录 `seed`）打乱候选顺序，标记为 `候选 A / B / C`；**彻底剥离** `variant`、`model`、`seconds`、`timestamp`、`traceId`、`reviewStatus`；将 `盲评字母 -> 真实候选` 映射单独写入 `blind-key.json`（严禁出现在盲评页）。
   - `grade_sheet.ts`：生成打分表模板（四栏：`参考答案要点 / 禁止断言 / 核心诉求 / 适用范围`，每栏 `符合 | 否决 | 修改` + `备注`）。
   - `agreement.ts`：计算评分者间一致率（原始一致率 + Cohen's Kappa），并调用 `server/src/stats.ts` 的 `clopperPearsonLower` 与 `wilsonInterval` 输出置信区间；支持同一评分者 20% 复评一致性计算。
   - `workbook.ts`：读取运行记录与打分表，计算 `00-README.md` §5 全部指标（覆盖率、交付正确率及单侧 95% CP 下界 + Wilson 双侧区间、严重误导率及单侧 95% CP 上界、违例率、耗时 P50/P90），**分开输出银标签与金标准表格**。
2. **避坑与测试**
   - 新建 `tests/server/blind_eval_tools.test.ts`：
     - 用 `acceptance-verified/grades.json` 的 120 条数据测试 `workbook.ts`（验证 candidate `22/60`、严重误导 `3/60` 等统计值与 CP 区间无误）；
     - 断言 `make_blind_pack.ts` 生成的盲评文本中搜索不到 `baseline`、`candidate`、`gemini`、`flash` 等字样，且用 `blind-key.json` 能 100% 还原候选身份。
   - 样例产物只写到 `tests/eval/reports/exec-v3/blind-sample/`（git 忽略）。

---

### Batch 3：M2 / M3 代码层准备（不调模型，零费用落地代码与单测）

1. **M2 代码准备**
   - 新建 `scripts/eval/review_benchmark_cases.ts`：将 `scripts/eval/review_optimization.ts` 里的 18 条受控虚构用例原样抽离（**一条不少**），扩展字段 `category` 与 `origin: 'fictional' | 'real-failure:<run_id>' | 'real-correct:<run_id>'`。
   - 新建 `scripts/eval/sanitize_case.ts`：实现等长形态保留脱敏（将 11 位手机号、18 位身份证号、17–20 位订单号、中文姓名替换为等长演示占位符，保留数字/字母形态与标点），并从 `acceptance-verified` 补入脱敏后的真实案例。
   - `scripts/eval/review_optimization.ts` 改为从 `review_benchmark_cases.ts` 导入用例，保持原有 CLI 行为兼容。
   - 新建单测 `tests/server/sanitize_case.test.ts` 验证脱敏后长度、形态不变且原敏感号清零。
2. **M3 代码准备**
   - `server/src/types.ts` 与 `server/src/config.ts`：新增 `reviewReasoningEffort: 'default' | 'low' | 'high'`（环境变量 `REVIEW_REASONING_EFFORT`，默认沿用 `geminiReasoningEffort`，允许 `'default' | 'low' | 'high'`）。
   - `server/src/agent/model.ts`：
     - 当 `purpose === 'answer_review'`（即 `Boolean(options?.signal)`）时，使用 `this.config.reviewReasoningEffort ?? this.config.geminiReasoningEffort` 决定 `reasoning_effort`（为 `'default'` 时传 `undefined`，为 `'low'` 或 `'high'` 时传对应值）；
     - 当 `purpose === 'investigation'` 时，继续使用 `this.config.geminiReasoningEffort`。
   - 在 `tests/server/model_timeout.test.ts` 或 `tests/server/business_model.test.ts` 中新增单测：断言调查调用与复核调用可独立设置不同的 `reasoning_effort`（例如调查用 `high`、复核用 `low` 或 `default`）。
3. **停机等批准边界（关口 G3）**
   - 代码与单测提交后，**不要自行发起任何真实模型调用**；在 `STATUS.md` 中汇总 `S3 + S7 + M2 + M3` 四项实验的预估调用次数与 token 预算，等待用户批准 **G3**。

---

### Batch 4：R5 特性开关骨架 + R4 反馈绑定（`40-phase3-review-delivery.md`）

1. **先做 R5（特性开关骨架）**
   - `server/src/types.ts` 与 `server/src/config.ts`：新增
     ```ts
     export interface FeatureFlags {
       partialPublish: boolean;
       timeBudget: boolean;
       inputGuard: boolean;
       feedbackBinding: boolean;
     }
     ```
     对应环境变量 `FEATURE_PARTIAL_PUBLISH`、`FEATURE_TIME_BUDGET`、`FEATURE_INPUT_GUARD`、`FEATURE_FEEDBACK_BINDING`，在 `loadServerConfig()` 中：`inputGuard` **默认 `true`**（S6 是已合入的安全修复、随 G0 窗口在生产生效，默认必须保持开启；仅显式设为 `'0'` 或 `'false'` 时关闭），其余三个开关**默认 `false`**（仅当值为 `'1'` 或 `'true'` 时为 `true`）。
   - `server/src/index.ts:88`（`GET /config/client`）与 `tests/helpers/business_fixture.ts:53`：返回对象增加 `features: config.features`（**必须保留 `businessApiVersion: 1` 不变**，以免破坏 `tests/integration/real_systems.it.test.ts:182`）。
   - **【避坑指令：R5 与 S6 `input_guard.test.ts` 的兼容】**：
     - `server/src/tools/index.ts:163` 当前无条件执行 `redactToolResult`，且 `tests/server/input_guard.test.ts:97-99` 传入 `{ codeRepoPath: root } as any`（无 `features` 属性）断言脱敏生效。
     - 因此在 `server/src/tools/index.ts` 中应写为：当 `cfg?.features ? cfg.features.inputGuard : true` 时执行 `redactToolResult`！这样：
       - `loadServerConfig()` 构造的完整 `ServerConfig` 带有 `features.inputGuard`（**默认 `true`**：S6 脱敏默认生效；`FEATURE_INPUT_GUARD=0` 时关闭、行为回到基线，满足 R5 的“关掉时与基线一致”）；
       - 未传 `features` 的旧单测（`input_guard.test.ts`）继续走脱敏分支保持全绿；
       - 在新增的 `tests/server/feature_flags.test.ts` 中专门测试 `features.inputGuard = false`（不脱敏）与 `features.inputGuard = true`（脱敏）两条路径。
       - 注：R5 原文写“默认全关”，但 R5 起草于 S6 采纳之前；`inputGuard` 承载的是已合入的安全修复（凭据入模脱敏），若默认关闭，R5 落地后的重启会静默回退 S6，故此处默认 `true` 是对 R5 的安全修正，其余三开关仍默认 `false`。
2. **再做 R4（反馈绑定到回合与答案）**
   - **表结构兼容升级（`server/src/db.ts:53` 附近）**：照 `auth_tokens` 的 `PRAGMA table_info(cs_feedbacks)` 模式，按需 `ALTER TABLE cs_feedbacks ADD COLUMN` 增加：
     - `turn_id TEXT`
     - `answer_id TEXT`
     - `verdict TEXT`
   - **公开回合 ID 与私有消息关联（`server/src/agent/service.ts`）**：
     - 在 `service.ts` 的 `start()` 中，公开回合 ID 是 `traceId`（`r_<uuid>`），且 `answer.traceId === turn.id`；
     - 在 `core.run` 开始前或 `checkpoint` 保存私有 `messages` 时，把本次 `core` 产生的消息（带有 `core` 内部 `turnId: t_<uuid>`）同时打上公开回合标识（例如在 `Message` 上加可选 `publicTurnId?: string`，或在 `prepareInput` / `checkpoint` 中标记 `m.turnId === currentCoreTurnId` 对应 `traceId`）。推荐在 `service.ts` 的 `checkpoint` 和结束保存时，将本轮新增消息关联到 `traceId`（或直接把 `traceId` 传给 `AgentOptions.turnId?: string` 让 `core.run` 直接用 `options.turnId || t_<uuid>` 作为 `turnId`——这样公开 `turn.id`、`answer.traceId` 与私有 `Message.turnId` 天然 100% 相等，最干净！但若采用此法，确保未传 `turnId` 时仍默认生成 `t_${randomUUID()}`）。
   - **服务端反馈处理（`server/src/index.ts:230` & `server/src/feedback_manager.ts`）**：
     - 支持请求体传入 `turnId`、`answerId`、`verdict`；
     - 当 `config.features?.feedbackBinding` 开启（或对新字段直接支持）时：
       - `user_token` 严禁再写入原始 Bearer Token，改为存员工标识或哈希（如 `req.user?.subjectId || sha256(token).slice(0, 16)`）；
       - `context` 只保留被反馈的那一回合的私有消息（按 `turnId` 过滤；未传 `turnId` 时只取最后一轮），且对消息内容先调用 `redactText`（`server/src/agent/input_guard.ts`）脱敏后再序列化入库；
       - 同一 `(session_id, turn_id, user_name)` 重复提交时做幂等去重（不重复插入多行）。
   - **前端与回放保留 `turnId`**：检查 `web/app.js`（`openFeedback`、卡片渲染、`handleEvent`）与 `src/business_web_server.ts`（`browserSession`），确保 `turn.id` 被保留并在点击反馈时随请求发送。
   - **【实施顺序建议（2026-10-14 审核核实）】** R4 拆三个提交，任一步可独立回退：① `packages/agent-core`：`AgentOptions` 加可选 `turnId`，`core.run` 内改为“`options.turnId` 优先、未传仍生成 `t_<uuid>`”（全仓无 turnId 格式断言，`t_` 前缀唯一出现处是 core.ts:118，安全）；② `service.ts` 传 `traceId` + 反馈接口/存储按 `turnId` 过滤与幂等；③ 前端透传：`web/app.js` 的 `openFeedback()` 改为接收并携带当前回合 id、`submitFeedback` 请求体加 `turnId`、`src/business_web_server.ts` 的 `browserSession` 在回放消息上透传 `turn.id`。
   - **存量只读核查**：用只读脚本查看 `server/data/xkang.db` 的 `cs_feedbacks` 存量行数及是否存在明文 `user_token`，把数字记入 `STATUS.md`（严禁写生产库；2026-10-14 审核实测为 0 行、尚无明文落库，但接口代码当前会把 Bearer 原文写入 `user_token`，R4 落地时纠正）。

---

### Batch 5：Phase 4 版本可信度（V1 样例 + V2 + V3 + V4，零模型费用）

1. **V1 样例与校验器（`50-phase4-version-trust.md`）**
   - 新建 `docs/exec-plan-v3/deployment-manifest.example.json`（进 git，符合 V1 schema，用占位符）。
   - 新建 `scripts/eval/validate_deployment_manifest.ts`：校验 JSON schema、检查每条 `artifactSha256` 格式合法、检查 `commit` 在镜像对应子仓库中可 `git --no-optional-locks rev-parse --verify`（并覆盖 `list_log_apps` 的 9 个服务名检查缺口）。
2. **V2 三档判定（`server/src/codegraph/version_trust.ts`）**
   - 实现 `evaluateRepoTrust(repoState, manifestEntry?)` 与 `evaluateAll(repos, manifest?)`：
     - **已核准（`approved`）**：manifest 中有该仓库/服务条目，`commit === headSha`，且有非空 `artifactSha256`；
     - **推定（`presumed`）**：非已核准，但工作区干净（`dirty === false`）**且** `HEAD` 恰好等于最新 `P*` 标签（正则 `/^P\d/`，`T1.0.0` 等非 `P` 标签不算！）；
     - **未知（`unknown`）**：其余全部（含**脏工作区 + HEAD==P 标签**、HEAD 越过最新 P 标签、只有 T 标签、无标签）。
   - 写单测 `tests/server/version_trust.test.ts` 覆盖全部 6 种矩阵场景；对只读镜像状态运行一次，确认产出 7 个 `presumed`、10 个 `unknown`，记录进 `STATUS.md`。注意：`server/data/codegraph/mirror-health.json` 要等 G0 后首次同步才会生成，本次采集须沿用 s1-verify 的临时目录 + 替身命令模式（或直接只读 git），不得为此触发生产同步或写入生产数据目录。
3. **V3 工具结果版本戳与图谱 `snapshot-manifest.json` 内置写入**
   - `server/src/codegraph/service.ts` 的 `rebuildIndex()`：在写完 `stats.json` 和 5 个分块文件后，同步写入同目录的 `snapshot-manifest.json`（包含 `createdAt`（必须与 `stats.json` 的 `createdAt` 完全一致）、`logicalRoot`、`physicalBuildRoot`、`sourceManifestHash`、`repositories`、`excludedPaths`、`graphFiles`、`stats`）。
   - `server/src/tools/codegraph.ts`：
     - `formatGraphResultToMarkdown` 头部增加 `【图谱快照】构建于 <createdAt> | 起点 <rootPath> | 清单哈希 <sourceManifestHash> | 与镜像当前状态一致: <是/否>`；
     - 顺手修正第 59 行已过时的注释（去掉“失败时还会 reset --hard”）。
   - `server/src/tools/code_search.ts`：
     - 在 `executeSearchCode`、`executeReadFileLines`、`executeGitInspect` 输出头部加上版本行（如 `【版本】skt-back/skt_cxy @ P1.2.1 (b87627d, 2026-10-13, 工作区干净) | 档位: 推定 | 判定时刻: ...`），多文件命中时在文件行附加短版本标识（`@P1.2.1` 或 `@b87627d`）；
     - **【避坑指令】**：当测试环境中的 `codeRepoPath` 下没有 `version-trust.json` 或子目录不是 git 仓库时，版本信息读取必须静默跳过或优雅回退，**不得破坏 `tests/server/code_search.test.ts` 与 `tests/server/path_policy.test.ts` 的既有断言**。
     - **【字符预算核对】**：按 `50-phase4-version-trust.md` V3 要求，加版本行后对固定查询（如 `search_code 'prod-config'`、读取一个长文件）记录加版本行前后的命中文件数与行数，确认没有明显减少（`CONTENT_CHAR_BUDGET=12000`、`TOTAL_CHAR_BUDGET=16000`、`PER_FILE_CHAR_BUDGET=3500`、`READ_CHAR_BUDGET=16000`），把前后数字与结论记入 `STATUS.md`。
4. **V4 运行起点版本固定与数据核对模式**
   - `runPin` 与版本漂移检测：在运行起点记录 `runPin`，工具调用发现仓库 `HEAD` 漂移时在工具结果头部追加 `【版本漂移】本次运行期间 <仓库> 已从 <A> 变为 <B>，以下结果可能来自不同版本。` 并标记 `version_drift = true`。
   - `git_inspect` 新增 `action: 'show'`（支持 `ref` 为标签、提交号或 `before:YYYY-MM-DD`，路径同样必须经过 `resolveRepoFile` 的 `path_policy` 与 `isInside` 校验）。
   - 数据核对模式（`publication.ts`）：当涉及仓库档位为 `unknown` 且开启对应检查时，拦截确定性的机制/原因/规则结论，只放行数据事实，结论段要求统一为 `"该服务的现行实现未能确认，以下为数据核对结果。"`（单测 `tests/server/version_pin.test.ts` 覆盖全部 4 项断言）。

---

### Batch 6：起草 Phase 3 设计文档（触发关口 G5，不改复核提示词）

在 `docs/exec-plan-v3/designs/` 下起草三份简明设计文档供用户拍板（**G5**）：
1. `D1-partial-publish.md`（R1：`PublicAnswer.claims` 可选字段结构、反证点名一律进 `pending` 的铁律、`service.ts` 在 `parsePublicDraft` 之后拼装新字段的方式）；
2. `D2-time-budget-freeze.md`（R2：`RunState` 与 `budget` 参数、`turnsAllowed`/`reviewAttemptsAllowed` 计算公式与 200/10 硬上限、`agent_sessions` 加列方案、`service.get()` 不擦除冻结状态、`POST /agent/sessions/:id/continue` 接口、线缆 `status` 保持 3 个枚举值不变而通过可选字段表示冻结）；
3. `D3-version-trust-and-data-only.md`（V2–V4：三档判定、工具结果版本戳、数据核对模式拦截规则）。

---

## 3. 验收清单（本轮结束时自查）

1. `npm test`（全部既有 229 项 + 本轮新增单测）、`npm run typecheck`、`npm run typecheck:test`、`cd server && npx tsc --noEmit` 全部通过。
2. **零模型费用确认**：`tests/eval/reports/exec-v3/usage-ledger.jsonl` 中无未经批准的付费模型调用。
3. **复核提示词零改动确认**：`git diff 636adda..HEAD -- server/src/agent/review.ts` 中 `CHALLENGE_PROMPT` 与 `REVIEW_PROMPT` 措辞只字未改（确保 M3 实验不受污染）。
4. `STATUS.md` 与 `memory/memory.md` 已同步更新，G2（M1 抽查包）、G3（S3/S7/M2/M3 预算单）、G5（三份设计文档）全部准备就绪并列在 `STATUS.md` 等待栏。
5. **S6 脱敏默认生效确认**：不设任何 `FEATURE_*` 环境变量时 `redactToolResult` 仍被执行（`inputGuard` 默认 `true`）；`FEATURE_INPUT_GUARD=0` 时才回到基线行为。
