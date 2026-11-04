# 附录：速查与模板

本文件是**查阅用**的，不需要从头读。做任务时按需查。

---

## A. 路径速查

| 路径 | 是什么 | 能不能写 |
|---|---|---|
| `D:\web_pro\xkang-tui` | 本仓库（无远程） | 能 |
| `D:\skt_project` | 代码镜像，服务端读取业务代码的地方 | **不能**。只读命令，git 一律加 `--no-optional-locks` |
| `D:\skt_project_backup_20261010-111550` | 换装前的旧镜像内容 | **不能**，且不要删除 |
| `D:\skt_project_fresh_20261010-111550` | 换装用的完整克隆源，还在 | **不能** |
| `C:\Users\skt\git\skt_cxy` | 开发的工作副本（有未提交改动） | **绝对不能动** |
| `server/.env` | 服务端配置（含真实凭据） | 能改配置项，**不许把值写进任何输出** |
| `server/data/xkang.db` | 生产审计库（`audit_logs`、`cs_feedbacks` 等） | 只读 |
| `server/data/codegraph/` | 图谱数据（约 580MB）+ `stats.json` + `snapshot-manifest.json` | **只在隔离目录里做实验**，不要覆盖生产的 |
| `server/data/service-lifecycle.jsonl` | 服务启动/退出/信号记录 | 只读 |
| `server/data/diagnostics/` | 致命错误报告 | 只读 |
| `tests/eval/reports/` | 评测产物（**被 git 忽略**，可含 PII） | 能 |
| `tests/eval/data/` | 工单集等数据（**被 git 忽略**） | 能 |
| `docs/exec-plan-v3/` | 本计划（进 git，**不含 PII 与密钥**） | 能 |

## B. 端口

| 端口 | 用途 |
|---|---|
| 8600 | **生产服务端**。不得停止、重启或修改 |
| 8691 | `startIsolatedServer` 的默认端口 |
| 8693 | `scripts/eval/business_acceptance.ts` 固定使用 |
| 8691–8699 | 允许给隔离服务端用 |

## C. 命令速查

**允许**
```bash
npm test
npm run typecheck
npm run typecheck:test
cd server && npx tsc --noEmit
npm run build
npm run test:ui
npm run test:ui:sessions
npm run test:ui:live
node --import tsx scripts/eval/review_optimization.ts <新目录> <基线review.ts路径>
node --import tsx scripts/eval/model_ceiling.ts evidence <新目录> flash-high
node --import tsx scripts/eval/model_ceiling.ts workflow <新目录> flash-high
npm run test:integration
```

**禁止**
```bash
npm run build:exe
```
（还会写 `server/data/releases/`、会打包分发给客服；`release_gate.mjs` 只被它调用）
```bash
node scripts/e2e_first_launch_key_binding.mjs
```
（会删真实的 `~/.xkang/config.json`）
```bash
node scripts/e2e_device_binding.mjs
```
（会删服务端数据文件）

**只读查询镜像的标准写法**
```bash
git --no-optional-locks -C D:/skt_project/skt-back/skt_cxy status --porcelain
git --no-optional-locks -C D:/skt_project/skt-back/skt_cxy log -1 --format="%H %ad" --date=short
```

## D. 服务端注册的工具（只有 8 个）

`server/src/tools/index.ts` 的 `createCompanyTools()`：

| 工具 | 作用 | 备注 |
|---|---|---|
| `lookup_order` | 按单号/票号/PNR 确定性地定位主订单 | 查单第一步 |
| `search_code` | 代码检索 | 受 S2 排除策略约束 |
| `read_file_lines` | 读代码文件（带行号） | 单次最多 400 行 |
| `git_inspect` | `log` / `blame` | **没有**按时间点取内容的能力（V4 要加） |
| `codegraph_explore` | 图谱查询：definitions / implementations / callers / callees / references | 静态解析，查不到≠不存在 |
| `search_logs` | 生产日志（Grafana/Loki） | 单次窗口 ≤2 小时 |
| `list_log_apps` | 列出可查的服务名 | 覆盖检查表要用它 |
| `company_db_query` | 只读 SQL（MyCat） | action: list_databases / list_tables / describe_table / search_schema / query |
| `web_search` | 仅在有 Key 时注册 | 未配置时不注册 |

**服务端不存在**：`write_file`、`edit_file`、`run_powershell`、`web_fetch`、`todo_write`、`query_company_database`、`knowledge_search`、`kg_query`。提示词里如果出现它们，就是缺陷（见 §I）。

## E. 硬编码限制速查

| 位置 | 值 |
|---|---|
| `server/src/tools/code_search.ts` | `CONTENT_CHAR_BUDGET=12000`、`TOTAL_CHAR_BUDGET=16000`、`PER_FILE_CHAR_BUDGET=3500`、`CONTENT_FILES_PER_PAGE=20`、`MAX_LISTED_FILES=150`、`MAX_COUNTED_FILES=5000`、`MAX_LINE_CHARS=250`、`RG_TIMEOUT_MS=15000`、`READ_DEFAULT_SPAN=300`、`READ_MIN_SPAN=120`、`READ_MAX_SPAN=400`、`READ_CHAR_BUDGET=16000`、`cutAtLineBoundary` 截断 12000 |
| `packages/agent-core/src/core.ts` | `turns >= 50` → 强制收尾；工具等待超时 `20000ms`（只 reject 不取消）；`reviewCount >= 2` 收尾；`repairRemaining = min(3, max(0, 50-turns))`；第 30、45 轮各有一条提醒；空回复重试 <2；协议错重试 <1；动作重试 <2 |
| `server/src/agent/review.ts` | 超时默认 `60000`（S7 改必填）；复核材料估算预算 `80000` token；反证问题上限 5 |
| `server/src/codegraph/sync_manager.ts` | fetch 45s、pull 45s、`rev-parse @{u}` 5s、reset 45s；`discoverGitRepos` 深度 3 |
| `tests/helpers/isolated_server.ts` | 就绪等待 90s；图谱加载等待 60s；默认端口 8691 |
| `scripts/eval/business_acceptance.ts` | 并发 4；单次 18 分钟强制中止；端口 8693；20 题 × 3 轮 × 2 版本 = 120 |
| `scripts/eval/model_ceiling.ts` | 多变体并发 3，单变体并发 1；`evidence` 20 题 / `workflow` 5 题 |
| `scripts/eval/review_optimization.ts` | 18 个受控虚构用例 × 2 轮 |

## F. 评测资产

**题库**
- `tests/eval/business_acceptance_cases.json` —— 20 题，字段 `{ id, category, question }`。
- id 清单（`category` 就是 id 的前缀）：`amount_refund_components`、`amount_hotel_cancel`、`amount_taxi_coupon`、`amount_air_change`、`scope_disabled_staff`、`scope_business_channels`、`scope_overlap_rules`、`scope_contact_traveler`、`branch_air_issue_retry`、`branch_train_cancel`、`branch_hotel_confirmation`、`branch_duplicate_refund`、`cause_payment_status`、`cause_notification_missing`、`cause_refund_accepted`、`cause_canceled_payment`、`advice_issued_unpaid`、`advice_hotel_double_charge`、`advice_train_refund_time`、`advice_contact_resend`。
- **5 道完整流程题**（`model_ceiling.ts` 的 `workflow` 模式，定义在脚本里的 `pilotIds`）：`amount_air_change`、`scope_disabled_staff`、`branch_duplicate_refund`、`cause_refund_accepted`、`advice_hotel_double_charge`。
- 本机历史业务问题：`tests/eval/reports/model-ceiling-20261009/historical-questions.json`。

**脚本**（`scripts/eval/`）
| 脚本 | 用途 |
|---|---|
| `business_acceptance.ts` | 20 题 × 3 轮 × 2 版本的完整验收（起隔离服务端，端口 8693，并发 4） |
| `model_ceiling.ts` | 固定证据（`evidence`）与完整流程（`workflow`）两个模式，多变体对照 |
| `review_optimization.ts` | 复核受控基准（18 条虚构用例，`expected` 不发进模型） |
| `model_ceiling_probe.ts` | 模型探测 |
| `business_smoke.ts` | 冒烟 |
| `replay_eval.ts` | **已停用**，直接退出码 1 |
| `release_gate.mjs` | 发布门禁，只被 `build_exe.mjs` 调用 |
| `compare_models.mjs` / `harness_batch.mjs` / `zcode_*.mjs` | 早期的对照与批处理 |

**报告目录**（`tests/eval/reports/`，全部被 git 忽略）
`server-harness-20261009/`（120 次验收与冻结源码）、`model-ceiling-20261009/`（同证据对照、消融、完整流程、评分细则）、`review-optimization*-20261009/`（复核迭代）、`mirror-reclone-20261010-111550/`（换装与保全证据）、`server-startup-20261013/`（启动诊断）、`model-probe-20261009/`（中转探测）。
本计划的新产物统一放 **`tests/eval/reports/exec-v3/`**。

**发布门禁的冻结范围**（`scripts/eval/business_acceptance.ts` 的正则，`release_gate.mjs` 消费）
```
packages/agent-core/src/**
server/src/tools/**
server/src/agent/{model,review,publication,investigation_prompt}.ts
server/src/{llm,model_state,system_prompt,skills,mcp}.ts
src/{mcp/client,tools/registry}.ts
```
加上单独哈希的 `BUSINESS_PROMPT`（从 `server/src/agent/service.ts` 里正则截取）。
`release_gate.mjs` 的判据**硬编码**为：20 道不同问题、120 次评分完整无重复、候选 ≥54/60 可用、≥59/60 正常结束、严重误导全为假、8 项验证（`unit`/`typecheck`/`integration`/`chromeUi`/`privacy`/`businessIdentifiers`/`candidateExe`/`migration`）全真。**换成工单集后这套判据全部失效。**

## G. 测试接缝

| 接缝 | 用法 |
|---|---|
| `new AgentService(store, config, audit, models, modelFactory?, registryFactory?)` | 后两个是工厂，用来注入假模型/假注册表 |
| `startBusinessFixture()`（`tests/helpers/business_fixture.ts`） | 内存库 + 假模型 + 假注册表，起一个 express，返回 `{ url, token, stop }`。假模型靠 **`options.signal` 是否存在**来分流"这是复核调用" |
| `startIsolatedServer(port, model?)`（`tests/helpers/isolated_server.ts`） | 起**真实**服务端进程（tsx 跑 `server/src/index.ts`），临时工作目录、`CODE_SYNC_ENABLED=false`、测试令牌。需要 `server/.env` 存在且模型可达。返回 `{ url, token, adminToken, readAudit, logs, stop }` |
| mock timers | 问题定时器与复核超时已经能用它测 |
| `new CodeSyncManager(service, targetProjectRoot)` | S1 要给构造函数加第三个可选参数 `runCommand`（默认真实实现），否则测不了"到底执行过哪些命令" |

`startIsolatedServer` 的两个成本要知道：就绪最多等 90 秒，图谱加载再等最多 60 秒；而且**它会加载真实的 `D:\skt_project` 图谱**（"已加载分块图谱索引"），内存峰值约 3.0GiB。

## H. 模板（B1 / B2 / B3）

> **可直接转发的版本已经写好**在 `requests/` 目录里：`R1-dev-G6-G8.md`（B1）、`R2-cs-lead-G7.md`（B2）、`R3-ops-G0-G1.md`（B3）。下面是它们对应的模板与说明，改文本时以 `requests/` 为准。**转发前请核对名单与数字是否仍与实测一致。**

### B1 给开发的请求（G6、G8）

> 主题：需要你确认几件事，用于把客服助手的答案校准到线上真实版本
>
> 1. **线上版本清单**：请对每个对外提供日志查询的服务（`cxy-web`、`cxy-booking`、`cxy-ibe`、`cxy-hotel` 等，完整名单我可以先提供），给出：服务名、运行入口、制品标识（war/jar 的 sha256 或镜像摘要）、对应提交或标签、生效时间。
>    说明：`skt_cxy` 的 pom 里没有 build-info 插件，**jar 哈希没法自动映射到提交**，所以只能请你给制品标识和提交号两样。只有提交号或只有标签**不够**——那只能是"推定"，不能算"已核准"。
> 2. **标签约定**：`P*` 标签是否等于"已发布到生产"？哪些仓库没有标签、你们怎么判断它们的线上版本？（我这边看到 17 个仓库里有 7 个一个标签都没有。）
> 3. **现行实现地图**：`skt_cxy` 与 `skt_dpxt_background` 有 296 个同名文件，分别服务哪些业务？`order/orderNew`、`invoice/invoiceNew`、`hotel/hotelNew`、`entityOld` 之间是什么关系，哪个现行在用？各 `*_old` 表是什么含义？
>    说明：**在你们确认之前我不会按猜测排除任何目录**，因为排错了会把正确答案一起排掉。
> 4. **业务概念对照**（每条一句话即可）：票务状态与资金状态、应收与实收、月结与现结、受理与到账、生成通知与实际送达、预订失败与出单失败、保留配置与当前有效——各自在数据和代码里怎么区分。
> 5. **历史文档清单**：哪些文档是"历史记录、不代表现行实现"？（例如 `CODE_REVIEW_ISSUES.md` 已经误导过一次。）拿到名单后我会在工具结果里统一打标。
> 6. **盲评排期**：摸底跑完后需要你盲评 30～40 条输出，每条约 5 分钟，合计约 3 小时。希望提前定时间。

### B2 给客服负责人的工单导出格式（G7）

> 主题：需要导出 60 条以上近期真实工单，用于校准客服助手
>
> 请按下面这个格式导出（表格或 Excel 都行），**不要做脱敏**——姓名、电话、证件、订单号、金额都请保留原样，因为这些正是要核对的数据。数据只会放在本机不进代码仓库的目录里，不会进提交、日志或对外报告。
>
> | 列名 | 说明 | 必填 |
> |---|---|---|
> | `ticket_no` | 工单号 | 是 |
> | `created_at` | 工单创建时间 | 是 |
> | `business_line` | 业务线（机票/酒店/火车票/打车/发票/短信通知/支付/其他） | 是 |
> | `question` | **客服的原始提问原文**（不要改写、不要总结） | 是 |
> | `attachments` | 附件（截图等）的文件名或内容 | 有就填 |
> | `handling` | 客服当时的处理过程与结果 | 是 |
> | `outcome` | 最终结论（已解决 / 转研发 / 未解决 / 其他） | 是 |
> | `core_demand` | **一句话说明这个工单到底要问什么** | 是（可后补） |
>
> 其中 `core_demand` 最关键：我们要用"是否回答了核心诉求"来算覆盖率。一句话就够，不需要写长。
> 如果近期工单在话题上比较集中在某几类，也请照实导出，不要为了凑多样性特意挑——**偏斜本身就是要报告的结果**。

### B3 给运维/负责人的请求（G0、G1）

> 主题：需要一次 30 分钟停机窗口 + 一份凭据轮换清单
>
> 1. **停机窗口**：需要重启一次服务端（`D:\web_pro\xkang-tui\server`，端口 8600），用于让"代码同步不再执行 `git reset --hard`"这一改动生效。**不再需要更换代码镜像**（换装已在 10-12 完成）。具体步骤见 `tests/eval/reports/exec-v3/restart-for-s1-runbook.md`，可以在窗口内逐条照做，并保留回滚路径。
> 2. **凭据轮换清单**：见同目录的 `credential-exposure-report.md`。我不做轮换，只提供清单：系统类别、涉及文件数、优先级。请说明哪些确实需要轮换、由谁执行。
> 3. **现网制品标识导出方式**：war/jar 的 sha256 或镜像摘要怎么取？这一步和开发那边的版本清单是同一件事。

## I. 已知提示词缺陷清单（S3 的输入）

`server/src/agent/investigation_prompt.ts` 与 `server/src/skills.ts`：

1. 描述了服务端**不存在**的本地工具：`write_file`、`edit_file`、`run_powershell`、`web_fetch`、`todo_write`。
2. 要求"注明表名、文件路径:行号"，而 `publication.ts` 的公开过滤会**拒绝**这些内容 → 照着做就会被拦。
3. 引用了**已移除**的工具：`query_company_database`、`knowledge_search`。
4. 把 `describe_table`、`search_schema` 当成独立工具，实际是 `company_db_query` 的 `action`。
5. 把只有 README 的空仓库 `skt_new_webview` 当作"新版"举例（`skt-front/skt_webview` 才是有代码的那个）。
6. 如果提到 `read_tool_result`：**先确认它在服务端到底存不存在**（它更像本地模式的分页读原文工具）。不存在就不要写。

**改的时候注意**：`investigation_prompt.ts` 在发布门禁的冻结名单里，改了它现有验收报告就作废（本轮不发布，只需在 `STATUS.md` 记一笔）。

## J. 用量台账格式

`tests/eval/reports/exec-v3/usage-ledger.jsonl`，每行一条：

```json
{"ts":"2026-10-14T12:00:00.000Z","task":"S3","model":"gemini-3.8-flash-high","purpose":"investigation","inputTokens":12345,"outputTokens":678,"reasoningTokens":512,"cachedTokens":9000,"durationMs":41230,"ok":true}
```

- `purpose`：`investigation` | `answer_review` | `grading` | `other`
- 失败时加 `"error":"<简短原因>"`，`ok:false`
- **不含任何密钥、令牌、客户信息**
- 中转**没有价格和用量接口**，单价未知 → **只报 token，不要估算金额**

## K. 每个实验必须记录的字段

沿用现有做法（`business_acceptance.ts` 的 `manifest.json` 就是这么写的）：

- 源码提交哈希，以及**是否有未提交改动**
- 配置快照：模型名、`reasoning_effort`、各项超时、预算、并发
- 环境变量名与取值（**不含密钥**）
- 随机种子（打乱题序用）
- 输入哈希（题面、证据包）
- 冻结的源文件哈希（`evaluationFiles` 那套）

运行产出目录约定：`tests/eval/reports/exec-v3/<任务号>-<日期>/`，**已存在 `manifest.json` 的目录不许覆盖**（现有脚本会直接拒绝，保留这个习惯）。

## L. 常见坑

1. **Git Bash 的 heredoc 会吃掉反斜杠**。写含 `\` 的代码（比如 Windows 路径、正则）不要用 heredoc，改用文件写入工具或 Node 脚本。
2. **路径有两种写法**：`D:\skt_project` 和 `/d/skt_project`，混用会出错。
3. **`npm test` 之前会先跑 `build:core`**（编译 `packages/agent-core`）。改了 agent-core 一定要跑完整的 `npm test`，只跑单测文件可能用的是旧的 `dist`。
4. **`git status` 也要加 `--no-optional-locks`**，避免和 IDE 抢锁（历史上出现过镜像"文件被占用"）。
5. **`server/data/codegraph/` 是生产的**。做图谱实验一律用隔离数据目录，不要覆盖它。
6. **图谱加载很重**：约 580MB 的 JSON 全部读进内存，峰值 RSS 约 3.0GiB，加载要几十秒。别在循环里反复建。
7. **预览面板太窄**，UI 验证以 `npm run test:ui*` 的输出为准，不要靠肉眼看截图。
8. **真实数据截图含 PII**，只能存 git 忽略目录，不要贴进对话。
9. **中转的高思考在首个字节前可能静默 150 秒以上**，所以**不要设过短的空闲超时**（这也是 S4 里"只设单次上限、不设空闲超时"的原因）。
10. **`prod-config` 不能全量硬重置**：它有 `core.sparseCheckout=true` 和 16 条 skip-worktree，硬重置会失败。任何"清理镜像"的动作都要先避开它。
11. **改 `src/` 不等于已经上线**：生产跑的是 `server/dist`，且当前 `dist/agent/model.js` 与源码不一致。受控切换是 G9。
12. **一条工单的追问、改写、重复运行不算独立样本**。统计时只计一次。
