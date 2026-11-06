# Phase 1 · 低风险快速改动

前置：先读 `00-README.md`（工作规则是最低要求）。本阶段**不花模型费用**，全部改动都要先写测试。

内部顺序：**S5 最先**（后面每个阶段都要用它记账和算区间），其余可以任意顺序。S1、S2 互相不依赖，可以并行。

**2026-10-14 重组并入：S8（发布词表误杀修复）、S9（工具超时记录 + 截图落盘去重）；S8 必须先于 M2。裁定与来源见 `05-change-plan.md`。**

---

## S5 统计库与用量台账

**目标**：把"置信区间"和"这次花了多少 token"变成两个可以调用的函数，后面的判断都建立在它们上面。

**依据**：`00-README.md` §5 要求单侧 95% Clopper-Pearson 加 Wilson 双侧区间；§4 要求每次付费调用记账。当前仓库里没有任何实现，之前的 120 次验收是靠外部脚本临时算的。

**改动点**
- 新增 `server/src/stats.ts`，导出：
  - `clopperPearsonLower(k, n, alpha = 0.05)` —— 单侧下界（`k` 次成功 / `n` 次尝试）；
  - `clopperPearsonUpper(k, n, alpha = 0.05)` —— 单侧上界（用于"0 例严重误导"这类断言）；
  - `wilsonInterval(k, n, alpha = 0.05)` —— 双侧；
  - `binomialTailGE(n, k, p)` —— 内部用的尾部概率，也导出便于测试。
  - 全部用对数伽马函数实现，**不要**用正态近似。
- 新增 `tests/server/stats.test.ts`。
- 新增 `scripts/eval/sample_size.ts`：输入期望下界、真实正确率、单次通过概率要求，输出所需样本量。Phase 5 用它把摸底结果换算成正式验收的规模。
- 新增用量台账：`server/src/usage_ledger.ts` 与 `scripts/eval/usage_ledger.ts`，两者写同一种 JSONL 到 `tests/eval/reports/exec-v3/usage-ledger.jsonl`。字段固定为
  `{ ts, task, model, purpose, inputTokens, outputTokens, reasoningTokens, cachedTokens, durationMs, ok, error? }`。
  `purpose` 取值 `investigation | answer_review | grading | other`。**不得写入任何密钥、令牌或客户信息。**

**步骤**
1. 先写 `tests/server/stats.test.ts`，锚点用已经用独立脚本复算过的值（容差 0.01 个百分点）：
   | k/n | 期望单侧下界 |
   |---|---|
   | 59/60 | 92.34% |
   | 58/60 | 89.88% |
   | 100/105 | 90.25% |
   | 99/105 | 89.03% |
   | 142/150 | 90.58% |
   | 96/100 | 91.08% |
   | 150/150 | 97.19% |
   | 0/150 上界 | 1.98% |
   | 0/40 上界 | 7.22% |
   | 0/60 上界 | 4.87% |
2. 实现 `server/src/stats.ts`，跑到测试通过。
3. 实现台账写入，并在一个隔离实例的测试里断言"至少产生一条记录，字段齐全"。
4. `npm test`、三项类型检查全绿后提交。

**验收**：统计单测全部通过且与上表一致；边界 `k=0` 与 `k=n` 有专门用例；台账有字段完整性测试。

**依赖**：无。**本阶段最先做。**

**关口**：无。

**风险与回滚**：区间函数在边界和浮点上有坑，靠锚点表兜住。若锚点与实现不一致，**先怀疑实现**，不要改锚点（锚点是用独立数值积分脚本算出来的）。

---

## S1 安全同步：不再硬重置 + 镜像健康记录

**目标**：`git pull --ff-only` 失败时不再抹掉镜像里的未提交改动；把"镜像脏 / 落后"变成一份随时可读的产物。

**依据**
- `server/src/codegraph/sync_manager.ts` 第 95–118 行：`pull --ff-only` 失败后走 `reset --hard <上游分支>`（第 104 行）或 `reset --hard HEAD`（第 109 行）。
- `server/.env` 里 `CODE_SYNC_ENABLED=true`、间隔 10 分钟，**所以这条路径现在是启用状态**，生产服务每个周期都会走一遍。
- 2026-10-10 就出现过一次镜像带两个未提交文件的情况；当时靠人工保全才没丢。当前镜像恰好干净，属于"暂时无害"，不是修好了。
- `skt-back/prod-config` 有 `core.sparseCheckout=true` 与 16 条 skip-worktree，**对它做全量硬重置本来就会失败**。

**改动点**（只改 `server/src/codegraph/sync_manager.ts`）
1. `pullRepo` 拆成三步，**任何情况下都不执行 `reset`、`checkout --force`、`clean`**：
   - `git fetch --all --prune`（保留现有 `-c core.protectNTFS=false` 与 45s 超时）；
   - 用 `git status --porcelain` 判断工作区。**非空就跳过**，返回 `{ skipped: true, reason: '工作区有未提交改动' }` 并带上文件名列表；
   - 干净时才 `git pull --ff-only`。失败即返回失败，不做任何"修复"。
2. 把 `execAsync` 变成构造函数的可选注入项（第三参 `runCommand?`，默认仍是真实实现），否则没法测"到底执行过哪些命令"。
3. 新增产物 `mirror-health.json`，写到代码图谱数据目录（和 `stats.json` 同目录，即 `server/data/codegraph/`）：
   ```json
   {
     "timestamp": "…",
     "healthy": false,
     "repos": [
       { "relativePath": "skt-back/skt_cxy", "branch": "main", "headSha": "…",
         "dirty": true, "dirtyFiles": ["src/…/Foo.java"],
         "pullResult": "skipped", "error": null }
     ],
     "skippedRepos": ["skt-back/skt_cxy"],
     "staleRepos": []
   }
   ```
   **`dirtyFiles` 只写相对路径，不写内容；不得写远端 URL**（可能含凭据）。
4. `SyncResult` 增加 `skippedRepos: number` 与 `skipped: GitRepoStatus[]`，`getStatus()` 一并返回健康摘要。

**步骤**
1. 先写测试（`tests/server/code_sync_safety.test.ts`）：
   - 用一个只实现 `rebuildIndex()` 和 `getStats()` 的替身 service，和一个记录调用的假 `runCommand`；
   - 用例一：`status --porcelain` 有输出 → 断言**没有**任何 `reset`/`pull` 被调用，且 `mirror-health.json` 里该仓库 `dirty=true`；
   - 用例二：工作区干净且 `pull --ff-only` 成功 → `pullResult='ok'`，HEAD 更新；
   - 用例三：工作区干净但 `pull --ff-only` 失败 → 返回失败，**仍然没有** `reset`。
2. 改实现，跑测试。
3. 在隔离实例里对**真实的 `D:\skt_project`** 跑一次只读校验：确认 `mirror-health.json` 生成，且 17 个仓库全部列出。（这一步只读镜像，允许；不许 `git fetch` 之外的写。）
4. `npm test` 全绿后提交。

**验收**：三个用例通过；假 `runCommand` 的记录里**不出现** `reset` 这个子命令；`mirror-health.json` 结构有测试；生产镜像未被修改（用 `git --no-optional-locks status --porcelain` 复查仍为空）。

**依赖**：无。

**关口**：G0（要在生产服务上生效需要一次重启窗口，手册见 `10-phase0-safety.md` 的 T0.3）。

**风险与回滚**：去掉硬重置之后，"镜像长期落后且无法快进"会一直存在。这是**希望暴露**的状态，由 `mirror-health.json` 呈现，Phase 4 会据此把它降级为"推定/未知"。回滚 = 还原该函数（但不要恢复 `reset --hard`）。

---

## S2 统一路径排除（检索 / 读取 / git / 图谱）

**目标**：让"哪些路径不许进模型"只有一份定义，四个入口共用。

**依据**：`00-README.md` §3 第 8–11 条，三条泄露路径都已实测可达。

**改动点**
1. 新增 `server/src/codegraph/path_policy.ts`，导出：
   - `EXCLUDED_DIR_NAMES`：`node_modules`、`.git`、`target`、`dist`、`build`、`.idea`、`.vscode`、`bin`，**加 `prod-config`**；
   - `EXCLUDED_FILE_GLOBS`：现有 12 条加 `!**/prod-config/**`、`!**/*.bak`、`!**/*.bak.*`、`!**/*.old`、`!**/*.orig`；
   - `isExcludedDir(name: string): boolean`；
   - `isExcludedPath(relPath: string): boolean`；
   - `EXCLUDED_REASON: Record<string, string>`（给工具结果用的一句话说明）。
   匹配必须按**路径段**，不能按子串——否则 `FooServiceOld.java` 之类会被误伤。
2. `server/src/tools/code_search.ts`
   - `EXCLUDE_GLOBS` 改为从 `path_policy` 取（保留原有导出名以免破坏调用点）；
   - `resolveRepoFile` 加入策略检查：无论是直接给出的路径还是按文件名搜出来的候选，命中策略一律返回"已排除"，**并说明原因**（不要静默变成"文件不存在"，那会让模型换关键词反复试探）。
3. `server/src/codegraph/indexer.ts`：`IGNORED_DIRS` 改为从策略取；文件层再加一次 `isExcludedPath` 检查（`prod-config` 的 yml 就是这样进图谱的）。
4. `git_inspect` 通过 `resolveRepoFile` 自动获得同样的排除，不需要单独改；但要补一个测试确认。
5. **物理路径校验（realpath，2026-10-14 重组并入）**：现在的边界检查只对 `path.resolve()` 后的字符串做前缀比对，绕不过符号链接与 Windows 目录连接点（Junction）。两处都要改，算法一致、各自实现：
   - `server/src/tools/code_search.ts` 的 `isInside`（第 415–419 行；调用点 `resolveRepoFile` 第 462 行、`read_file_lines` 第 492 行、scope 根上溯第 614 行）；
   - `src/tools/sandbox.ts` 的 `validatePathInRepo`（第 26–29 行，写/编辑工具用；**目标文件可能尚不存在**）。
   算法：先 `fs.realpathSync.native` 解析 root 与候选路径再比较；候选不存在（ENOENT）时**向上取最近的存在祖先**做 realpath，再把剩余段拼回去；realpath 失败一律回退到现有字符串比较。Windows 下比较前统一小写（保留现有行为）。**不得改变其它语义**：路径逃逸拦截、`.git` 拦截、`prod-config` 排除照旧。

**明确不做（重要）**
- **不要**排除 `orderNew` / `invoiceNew` / `hotelNew` / `entityOld` / `*_old` 这类新旧并存的目录。哪一个是现行实现在**开发确认（G6）之前无法判断**，猜错会把正确答案一起排掉。
- **不要**按"仓库里只有 README"来排除 `skt-back-new/*`、`skt-front/skt_new_webview`，同样等 G6。它们的"历史文档"标记属于 Phase 4 的 V3。

**步骤**
1. 先写 `tests/server/path_policy.test.ts`：一张判定表，正例反例都要有。
   - 应排除：`skt-back/prod-config/cxy-transfer/application.yml`、`skt-back/prod-config/nacos/application.properties`、任意 `**/*.bak`、`**/*.bak.20261010`、`**/*.old`、`node_modules/**`、`**/target/**`。
   - **不得排除**：`skt-back/skt_cxy/.../SktHotelCLOrderServiceImpl.java`、`skt-back/skt_dpxt_background/.../OrderNewServiceImpl.java`（含 "old"/"new" 字样的正常文件名）、`skt-back/sktprojecthotel/skt-system/src/main/resources/application-web.yml`（不属于 prod-config 的配置）。
2. 新增 junction 越界测试（服务端并入 `tests/server/path_policy.test.ts` 或新建 `tests/server/path_boundary.test.ts`；客户端新建 `tests/client/sandbox_path.test.ts`）：在 `os.tmpdir()` 下建 `root/`、`outside/`，用 `fs.symlinkSync(outside, root/link, 'junction')` 建连接点，断言 `isInside(root, root/link/f)` 为 false、`validatePathInRepo` 拒绝；再断言正常子路径与"尚不存在的新文件路径"仍然放行。**绝不在 `D:\skt_project` 或任何真实仓库里建连接点。** 连接点创建失败（权限受限环境）时显式 `t.skip` 并打印原因，不得静默通过。
3. 改四个入口与两处路径检查（`isInside`、`validatePathInRepo`），补测试。
4. 在一个隔离数据目录里重建一次图谱（**绝不覆盖 `server/data/codegraph/`**），确认 `references.json` 里不再出现 `prod-config`。
5. 用真实 `D:\skt_project` 复跑 `10-phase0-safety.md` T0.4 第 3 步的三条可达性检查，三条都应变成"不可达"。
6. `npm test` 全绿后提交。

**验收**：判定表测试通过；图谱重建产物里 `prod-config` 命中数为 0；三条可达性检查全部由"可达"变"不可达"；`search_code` 的返回条数变化记录进 `STATUS.md`（用于确认没有大规模误伤）。

**依赖**：无。

**关口**：G0（生产图谱重建 + 生效要重启）。

**风险与回滚**：排除过宽会把正确答案一起排掉，所以判定表必须有足量正例，并在验收里对比"排除前后各仓库可检索文件数"。若某仓库文件数断崖下跌，先停下来查，不要调宽规则了事。回滚 = 撤销策略里的新增条目。

---

## S3 提示词修正

**目标**：让提示词只描述真实存在的工具和真实的约束。

**依据**：`00-README.md` §3 第 18 条。服务端**只注册 8 个工具**（`server/src/tools/index.ts` 的 `createCompanyTools`）：`lookup_order`、`search_code`、`read_file_lines`、`git_inspect`、`codegraph_explore`、`search_logs`、`list_log_apps`、`company_db_query`（`web_search` 仅在有 Key 时注册）。

**改动点**（`server/src/agent/investigation_prompt.ts`、`server/src/skills.ts`）
1. 删掉服务端不存在的本地工具的全部描述：`write_file`、`edit_file`、`run_powershell`、`web_fetch`、`todo_write`。
2. `describe_table`、`search_schema` 一律写成 `company_db_query` 的 `action`，不要写成独立工具。
3. 删掉已移除的工具引用：`query_company_database`、`knowledge_search`。
4. "注明表名 / 文件路径:行号"的要求**改成写在内部证据里**，并明确写清"公开答案里不得出现表名、SQL、源码路径、内部地址"。现在的写法与 `publication.ts` 的公开过滤直接冲突，模型照着做就会被拦。
5. 把"新版"的例子从空仓库 `skt_new_webview` 换成有实际代码的仓库（如 `skt-front/skt_webview`），或直接去掉这个例子。
6. 如果引用 `read_tool_result`，先确认它到底在哪些模式存在（它在 `05` 记忆里被描述为本地客户端的分页读原文工具，服务端未必注册）。**不存在就不要写。**

**步骤**
1. 先写 `tests/server/investigation_prompt.test.ts`：断言提示词文本里不出现那 5 个不存在/已移除的工具名；`describe_table` 只以 action 形式出现；不再出现 `skt_new_webview` 作为"新版"示例。
2. 改文本，跑到测试过。
3. 用同一份证据跑一次 `scripts/eval/model_ceiling.ts` 的 `evidence` 模式的**单变体**（`flash-high`，`--variants` 只留一个，避免并发干扰），与 `model-ceiling-20261009/evidence/` 的同一变体对比关键结论数。**这一步要花钱，先向用户报预算**（预估：20 题 × 1 变体 ≈ 与 10-10 那次同量级）。
4. `npm test` 全绿后提交（实验产出单独记进 `STATUS.md`）。

**验收**：提示词测试通过；回归对比记录"关键结论不下降"（若下降，先回退第 4、5 条只留删无效工具的改动）。

**依赖**：S5（记账）。

**关口**：G3（模型费用预算）。

**风险与回滚**：`server/src/agent/investigation_prompt.ts` 在发布门禁的哈希名单里，改了它**现有那份验收报告就作废**。本轮不发布，所以只影响"以后要重新验收"这件事，在 `STATUS.md` 记一笔即可。

---

## S4 模型调用时限与整体取消

**目标**：任何一次模型调用都有上限；一次运行可以被整体取消。**不设过短的空闲超时。**

**依据**
- `server/src/agent/model.ts` 第 29 行：只有复核调用（`options.signal` 存在时）才给 `timeout`，其余用 SDK 默认；`maxRetries` 也是 SDK 默认。
- `server/src/agent/service.ts` 第 100 行附近：`new BusinessModel(...)` **从不传** `runSignal`，所以 `run()` 期间无法从外部取消。
- 已知事实：高思考时首个字节前可能静默 150 秒以上，**空闲超时设短了一定会误杀**。

**改动点**
1. `server/src/config.ts`：新增 `modelCallTimeoutMs`（环境变量 `MODEL_CALL_TIMEOUT_MS`，默认 240000，允许 30000–600000）。
2. `server/src/agent/model.ts`：
   - 复核调用继续用 `config.answerReviewTimeoutMs`；
   - **其余全部调用**显式带 `timeout: config.modelCallTimeoutMs`；
   - `maxRetries` 显式写成 1（当前是 SDK 默认的多次重试，叠加超时后单次调用最长可达十几分钟）；
   - 保留现有 `reasoningEffort` 逻辑（`gemini` 且配置不是 `default` 时传 `high`）。
3. `server/src/agent/service.ts`：把运行级 `runSignal` 传进 `BusinessModel`。
   **不要**改用 `options.signal` 做运行级取消——它现在的语义是"这是一次复核调用"，测试替身（`tests/helpers/business_fixture.ts`、`tests/server/agent_privacy.test.ts`）靠它分流。

**步骤**
1. 先写测试（用假 gateway / mock timers，不打真实模型）：普通调用带超时；复核调用用复核超时；`runSignal` 被透传到 `streamChat`；`abort()` 之后 `run()` 在有限步数内结束。
2. 改代码，跑到测试过。
3. `npm test` 全绿后提交。

**验收**：四项断言都有测试；代码里不再出现"只有复核分支才设时限"的写法。

**依赖**：无。

**关口**：G9（在生产生效需要重启）。

**风险与回滚**：超时要走既有兜底路径，不能变成未捕获异常导致会话卡死。回滚 = 把默认值调大或还原三处；**不要把 `timeout` 删掉**。

---

## S6 凭据入模过滤（输入侧）

**目标**：S2 是"搜不到"，S6 是"即使搜到了也不送进模型"。两条都要有。

**依据**：`publication.ts` 的 `PRIVATE_PATTERNS` 只作用于**对客服发布的答案**，模型请求里仍是全文。prod-config 的配置在 2026-10 之前就可能已经进入过请求。

**改动点**
1. 新增 `server/src/agent/input_guard.ts`：
   - `redactText(text: string): { text: string; hits: Array<{ line: number; keyName: string; kind: string }> }`；
   - 识别形态：YAML/`properties` 的 `key: value` 与 `key=value`、JDBC 连接串里的 `password=`、`Authorization: Bearer …`、`-----BEGIN … PRIVATE KEY-----` 块、JSON 里的同名键、`.env` 风格、以及**键名命中敏感词且值 ≥32 字符的高熵串**；
   - 键名敏感词：`password|passwd|pwd|secret|token|credential|access[_-]?key|api[_-]?key|private[_-]?key|app[_-]?secret|sign[_-]?key|salt`；
   - 命中后把**值**替换成 `***REDACTED:<键名>***`，**保留键名和行号**，并在该工具结果末尾追加一行："本结果中有字段已按安全策略脱敏，不得猜测其值，也不得在回答中提及该字段。"
2. 接入点选**服务端工具包装层**（`server/src/tools/index.ts` 的工具执行路径），不要改 `packages/agent-core`——`agent-core` 与服务端业务路径、本地 `--local` 模式共用，改它影响面更大。
3. 记账：每次发生脱敏，往用量台账写一条 `purpose: 'other'` 的元记录（只记工具名、命中条数和键名，**不记值**）。

**步骤**
1. 先写 `tests/server/input_guard.test.ts`，正反例都要：
   - 应脱敏：`spring.datasource.password=Abc123456`、YAML 缩进形式、`jdbc:mysql://user:Passw0rd@host/db`、`Authorization: Bearer eyJ…`、PEM 块、`{"api_key":"…"}`。
   - **不得脱敏**（关键）：`orderId: 1530517490084478976`、`amount: 81.43`、`token_count: 128`、`orderNo: 9993903209296`、中文正常业务文本。
2. 实现，跑到测试过。
3. 在隔离实例里跑一次真实 `search_code`（关键词 `datasource`，`scope: backend`），断言返回里**不含**任何 `password=` 之后的值。**这一步只读，允许。**
4. `npm test` 全绿后提交。

**验收**：正反例全部通过；隔离实例的真实检索结果里没有凭据值；台账里能看到脱敏事件（键名与条数，无值）。

**依赖**：S5（台账）。

**关口**：G1（轮换清单仍然要给负责人，执行模型只出报告、不动凭据）。

**风险与回滚**：误伤会让模型看不到正常字段，所以规则要"键名命中 **且** 值形态命中"双条件，且**必须有不得脱敏的用例**。用特性开关控制（Phase 3 R5），默认先关，验证后再开。

---

## S7 复核工程性修复（**不改判断标准**）

**目标**：修掉复核里"结构上不可能通过""材料自身把预算撑爆""静默默认值"这三类缺陷。**判断标准一律不动。**

**依据**：`00-README.md` §3 第 12、16、17 条与 `review.ts` 的具体行。

**改动点**
1. **`performed_action` 永远不可能通过**（`server/src/agent/review.ts` 的 `validateReview`）：它要求引用 `write_file`/`edit_file`/`run_powershell` 的记录，而服务端根本没有这些工具。修法：把"只是做了只读查询"的断言归到事实类，不要判成 `performed_action`；`performed_action` 只保留给"助手声称自己执行了写操作"这一种（在服务端一律判不通过，因为本来就不允许）。**不要放宽"助手不得声称已执行动作"这条原则。**
2. **同一缺陷的第二处**（`packages/agent-core/src/core.ts` 第 199 行附近，硬编码 `['run_powershell','write_file','edit_file']` 判断"助手是否声称执行了动作"）。**先更正一个事实（2026-10-14 核实）**：`if (this.options.review)` 分支的每条路径都会 `return finish` 或 `continue`，所以**在配置了复核的运行里（服务端业务路径）这一段不可达**，不存在"每轮白烧轮次"。它实际只在**无复核的运行**里执行：本地客户端模式（那里三个工具真实存在，检查按设计工作）与无复核的服务端 harness。在无复核 harness 里硬编码集合永远匹配不上：助手写出"我已执行/已运行/已修改/已写入"（包括"我已执行查询"这类只读表述）就会触发"不能声称操作已执行"的提示，最多重试两次后把回答替换成兜底文本。改法：动作工具集合改为**显式传入或从注册表派生**（`options.actionTools` 优先；未传时取注册表里 `requiresApproval === true` 的工具名）。**语义保持不变**：通道里不存在动作工具时，"我已修改/我已执行（写动作）"这类声明仍判为不实、照样拦；只读表述（"我已查询/我已核对"）本来就不匹配正则，**不得**把检查放宽到匹配它们。
   - **注意 `packages/agent-core` 与本地 `--local` 模式共用**，而这三个工具在本地是真实存在的（`scripts/e2e_p2_edit_tools.mjs`、`scripts/e2e_p3_powershell.mjs` 在测它们）。**不许**直接把这一段删掉——那会让本地模式失去"不许谎称已执行"的保护。必须两边都有测试：无复核的服务端形态（集合为空 → 只读表述不触发提示，写动作声明仍被拦）与本地形态（集合非空 → 仍然拦得住）。
3. **复核材料里的图片 base64**（`review.ts`）：把截图从材料里剥掉，只留 `[截图 N：约 WxH，已省略二进制内容]` 的占位。单张 200KB 的图现在就能撑爆 80000 token 估算预算，导致整次复核失败。
4. **静默超时默认值**（`review.ts` 约第 126 行）：`options.timeoutMs ?? 60000` 改成**必填**，调用方漏传就抛错。默认值让"调用方以为传了 180s、实际跑 60s"这种问题无法暴露。
5. **格式失败的提示更具体**：把程序检测到的字段路径回送（这是既有行为的一部分，此处只是补齐）。**不得**回灌错误响应原文，也不得给出"应该通过/不通过"的暗示。

**明确不做（排在 M3 之后，见 Phase 3 R1）**
- 不改提示词措辞；
- 不改"反证最多 5 个问题"的上限；
- 不放宽"全部通过才发布"（部分发布是 Phase 3 的 R1）。

**步骤**
1. 先写测试（`tests/server/review_fixes.test.ts`）：
   - 一个只做了 `search_code` / `company_db_query` 查询、没有任何写动作的候选答案，**不再**因为 `performed_action` 被拦；
   - 含 base64 图片的材料包，估算 token 不随图片大小线性增长（用两张不同大小的图对比）；
   - `reviewAnswer` 不传 `timeoutMs` 时抛错；
   - 格式失败的错误信息里包含字段路径。
2. 先写 `core.ts:199` 的两侧测试（**必须用无复核配置**——配置了 review 时这段代码不可达）：
   - **无复核的服务端形态**（注册表里没有动作工具）：助手说"我已查询/我已核对"这类只读表述不触发提示（守护现状）；说"我已修改/我已执行（写动作）"时**仍然**被拦（设计意图，不是误报）；
   - **本地形态**（注册表里有 `write_file` 等）：助手声称已执行但没有任何成功记录时，**仍然**被拦；有成功记录时放行（这两条是回归，必须保持绿）。
3. 改实现，跑到测试过。
4. 跑一次复核基准（M2 建好之前，先用 `scripts/eval/review_optimization.ts` 的现有 18 个受控用例）确认**检出率没有下降**。这一步要花钱，先报预算。
5. `npm test` 全绿后提交。

**验收**：上述测试全部通过；受控用例的检出率不低于变更前（记录到 `STATUS.md`）；**没有任何提示词措辞被改动**（用 `git diff` 自查）；本地模式相关用例未回归。

**依赖**：无（M2 的完整回归放在 Phase 2 做）。

**关口**：G3（模型费用）。

**风险与回滚**：放宽 `performed_action` 会减少误拦，理论上可能放过少量该拦的。用受控用例的检出率守住；若下降，就只保留第 2、3、4 条，把第 1 条改成"只有同时缺少事实依据时才拦"。

---

## S8 发布词表误杀修复（**不改发布边界**，2026-10-14 重组并入）

**目标**：`collectPrivateTerms` 不再把日常业务缩写（APP/VIP/PDF/OTA/SMS/H5/PC 等）和用户自己写过的单号当成"内部标识"，同时**保持**对真实内部类名、表名、长字段名的拦截。

**依据**（逐行核实，`server/src/agent/publication.ts`）
- 第 30 行：`add()` 收集任何"长度 ≥ 3 且含字母"的字符串进词表；第 55 行的正则从 `search_code`/`read_file_lines`/`codegraph_explore` 结果里提取赋值目标与字段声明（`app =`、`vip =`、`private String pdf;` 都会被收）；第 38/43 行的键名列表里有 `app`；第 49 行连查询结果的**列名**都收。
- 第 66 行 `checkPublicText` 用大小写不敏感的词边界正则匹配 → 词表里有 `app` 时，公开答案里出现"APP"即报 `internal_identifier`。
- 后果链：初稿被 `parsePublicDraft`（第 73 行）打回；降级保留的 `fallback` 在 `review.ts:189` 被同样清空 → 整题降级。这是"正确答案被自己人拦掉"的直接来源之一。

**改动点**（只改 `server/src/agent/publication.ts`）
1. 新增 `isPrivateTermCandidate(text: string): boolean`，判定 `text.length >= 6 || text.includes('_') || /[a-z][A-Z]/.test(text)`；第 30 行的条件改为它。**第 32 行的文件名分支（`.java/.vue/.ts/.js/.sql/.xml` 的 basename）保持不变。**
   - 结果：`app/vip/pdf/ota/sms/url/fee/tax/day/h5/pc/ios/pnr` 不再入表；`deleted`(7)、`refund`(6)、`orderNew`（大小写过渡）、`t_order_hotel`（下划线）、`serviceCharge`、`SktHotelCLOrderServiceImpl` 仍然入表。
2. **用户自带词豁免**：从用户消息（`role === 'user'` 且 `!isReminderMessage(m)`；`isReminderMessage` 与 `messageText` 从 `@xkang/agent-core/context` 导入，`review.ts:4` 有先例）提取**纯字母数字 token**：按非字母数字切分，保留 `/^[A-Za-z0-9]{2,12}$/` 且**不含小写→大写过渡**的 token，统一小写放入豁免集合；`add()` 开头命中豁免即返回（文件名分支不受影响，因为含点号不会进豁免集合）。客户单号（如全大写的 6 位编码）由此豁免。
3. **不要**做固定白名单（审计报告建议的 `PUBLIC_SAFE_TERMS`）——形态规则 + 用户豁免已覆盖同一问题，白名单会长期腐化。

**明确不做**
- 不动 `PRIVATE_PATTERNS`、不动 `checkPublicText` 的匹配方式（大小写不敏感与词边界保持）；
- 不放宽 `parsePublicDraft` 的严格校验。

**步骤**
1. 先写 `tests/server/publication_terms.test.ts`：
   - 误杀清单：工具结果含 `const app = …; const vip = …; const pdf = …;` 时，`checkPublicText('请引导客户在 APP 中查看 VIP 订单，或导出 PDF 行程单。', terms)` 违例数为 0；
   - 用户豁免：用户消息含 `HVBJEE`、工具结果也含它时，公开文本写"单号 HVBJEE"不违例；但用户消息含 `orderNew`（大小写过渡）时**仍**违例；
   - 内部标识仍拦：`serviceCharge`、`deleted`、`t_order_hotel`、`SktHotelCLOrderServiceImpl`、`orderNew` 全部仍报违例；
   - 边界：5 字符（如 `notes`）不入表、6 字符（如 `refund`）入表；
   - 现有 `tests/server/publication.test.ts` 的 3 项**必须保持绿**（已核对与 S8 兼容）。
2. 改实现，跑到测试过。
3. `npm test`、三项类型检查全绿后提交。

**验收**：误杀清单与内部标识两组断言都通过；现有 publication 测试不回归；无模型费用。

**依赖**：无。**必须先于 M2**（它改变复核基准里"误拦"的底噪）。

**关口**：无。

**风险与回滚**：放宽后，3–5 字符的内部短名（纯小写无下划线者）不再被拦——接受的取舍：公开答案本就要求中文业务语言，由 `PRIVATE_PATTERNS` 与提示词兜底。若验收发现真实内部名被放过，把 `isPrivateTermCandidate` 的阈值调回 5 或给该形态加条件，**不要**恢复长度 3。改动文件在发布门禁哈希名单里，本轮不发布，`STATUS.md` 记一笔即可（同 S3）。回滚 = 还原第 30 行条件。

---

## S9 工具超时记录与截图落盘去重（2026-10-14 重组并入）

**目标**：(a) 工具 20 秒超时后 `evidence.outcome` 记为 `not_executed`（现在误记为 `failed`）；(b) 同一张截图在多轮对话中只落盘一次。

**依据**（逐行核实）
- (a) `packages/agent-core/src/core.ts`：第 165 行 20 秒 `Promise.race` 超时只 reject；第 169 行 `catch` 调 `this.result(call, …)` **未传** `notExecuted`；`result()`（第 96 行）的 `outcome` 因此是 `failed`。证据被标记为 `failed` 与"未执行"语义不同（未执行 = 结果未知，既不得当作执行过，也不得当作执行失败来推断业务结论）。
- (b) `server/src/llm.ts`：`saveBase64ImagesToDiskAndExtractPaths`（第 308–348 行）在**每次** `/v1/chat/completions` 请求时遍历全部历史消息，用 `img_${Date.now()}_${随机}.${ext}`（第 332 行）重新写盘 → 多轮对话中同一张历史截图被重复写几十次。`_savedLocalPath` 只用于服务端日志摘要（第 365 行），发往中转的消息里已在第 269 行剥离——所以修复的理由是**磁盘写放大与审计日志路径不稳定**，与提示缓存无关。

**改动点**
1. `packages/agent-core/src/core.ts`：
   - `AgentOptions` 新增可选 `toolTimeoutMs?: number`（默认 20000，不改变默认行为）；
   - 超时的 promise 改 reject 一个带标记的错误（`const timeoutError = new Error('工具等待超时，执行结果未确认'); (timeoutError as any).notExecuted = true;`）；
   - 第 169 行 `catch` 里读出该标记并传给 `this.result(..., notExecuted)`；**其它异常保持现状**（不加标记 → 不记为 `not_executed`）。
2. `server/src/llm.ts`：文件名改为内容哈希——`img_${sha256(base64Data).slice(0, 16)}.${ext}`；`fs.existsSync(filePath)` 为真时**跳过写盘**，但仍 `savedPaths.push` 并设置 `part._savedLocalPath`（复用同一路径）。函数改为 `export`（供测试导入）；返回值与副作用保持不变；月份子目录结构不变。

**步骤**
1. 先写测试：
   - `tests/client/finalization.test.ts` 追加（或新建 `tests/client/core_tool_timeout.test.ts`）：注册表里放一个永不 resolve 的工具，`toolTimeoutMs: 30`，第一轮请求该工具、第二轮给最终文字；断言该工具消息的 `evidence.outcome === 'not_executed'`、文本含"超时"；再加一条守护用例：工具抛普通异常时 outcome **不是** `not_executed`（记录实际值，只钉住不回归）。
   - 新建 `tests/server/llm_images.test.ts`：临时目录作 `baseDir`，同一张图两次调用 → 只产生 1 个文件且两次 `_savedLocalPath` 相同；两张不同图 → 2 个文件；第二次调用不重写（用文件数与内容断言，不用 mtime）。
2. 改实现，跑到测试过。
3. `npm test`、三项类型检查全绿后提交。

**验收**：超时 `not_executed`、普通异常不误记、同图只落盘一次，三组断言通过；`llm.ts` 的导出不破坏现有导入。

**依赖**：无（S9a 与 S7 同改 `core.ts`，建议与 S7 相邻提交，减少冲突）。

**关口**：无（不花钱；在服务端生效属 G9 窗口的事）。

**风险与回滚**：历史目录里旧的随机名文件不清理（不在本任务范围）。`toolTimeoutMs` 只用于测试注入，生产默认值不变。改动文件在发布门禁哈希名单里，本轮不发布，`STATUS.md` 记一笔即可（同 S3）。回滚 = 还原文件名生成与 catch 传参。
