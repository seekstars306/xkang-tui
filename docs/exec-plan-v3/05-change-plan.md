# 05 · 修改方案重组（v3.1）：审计报告裁定与新增任务

> 2026-10-14 编写并核实。本文件是执行计划 v3 的重组入口：对 2026-10-13 外部审计报告逐条裁定，并把**采纳的部分**写成可执行任务。阅读顺序：`00-README.md` → 本文件 → `06-execution-guide.md` → `07-phase2-4-execution-guide.md` → `08-g3-experiments-and-r1-r3-guide.md`（G3 实验 + Phase 3 R1–R3 指南）→ `STATUS.md` → 一次一个阶段文件。**本文件及 `06`/`07`/`08` 指南与阶段文件冲突时以前者为准**（阶段文件已同步修订）；再发现不一致，先写 `STATUS.md` 的偏差栏再继续。所有面向用户的汇报用中文。

## 1. 裁定摘要

- 审计报告的**缺陷诊断基本属实**：它给出的行号（`review.ts:84`、`publication.ts:25-69`、`core.ts:165/169`、`code_search.ts:415-419`、`sandbox.ts:26-30`、`llm.ts:308-348`）逐条核对，全部对得上。
- 但它声称**已经完成的** 9 项代码修改、5 项新增测试、"175 项测试全绿"，**在本仓库不存在**（核实记录见 §5）。它只能当"问题清单"用，不能当"已完成工作"的证据。
- 处置：**采纳 4 项**，新并入为任务（S2 第 5 项、S8、S9a、S9b）；**6 条与既有任务重合**，不重复立项（§2 对照表）；**拒绝 6 条**（§4）。

## 2. 报告条目 → 去向对照表

| 报告条目 | 去向 |
|---|---|
| §2.1 复核材料含截图 base64，撑爆 80000 token 预算 | 既有 **S7 第 3 项**（图片替换为占位文本） |
| §2.2 `collectPrivateTerms` 词表误杀（APP/VIP/PDF、用户单号） | **新任务 S8**（形态规则 + 用户自带词豁免；不用报告建议的白名单） |
| §2.3a 工具 20 秒超时被误记为 `failed` | **新任务 S9a**（超时错误带标记 → `not_executed`） |
| §2.3b 主循环缺墙钟收敛水线（建议硬编码 12 分钟） | 方向并入 **R2**；硬编码常量拒绝（§4-2） |
| §2.4 `isInside` / `validatePathInRepo` 缺 realpath 物理路径校验 | **S2 新增第 5 项** |
| §2.5 多轮对话重复落盘同一张截图 | **新任务 S9b**（内容哈希命名并复用） |
| §1 表：提示词与公开过滤自相矛盾 | 既有 **S3** |
| §1 表：复核失败/超时整单清零 | 既有 **R1**（按断言粒度发布）；"challenge 阶段自动恢复"的实现路径不采纳（R1 红线：反证点名一律进待核实，自动保留会绕过它） |
| §1 表：`performed_action` 死锁 | 既有 **S7 第 1 项** |
| §1 表：`git reset --hard` 风险 | 既有 **S1** |
| §1 表：`prod-config` 未排除 | 既有 **S2 主项**（且不止 glob，见 §4-3） |
| §3 表：`validateReview` 允许只读查询 | 既有 **S7 第 1 项** |
| §3 表：`sandbox.ts` 补 realpath | **S2 第 5 项** |
| §3 表：`challengeSchema` 5→20 | 拒绝（§4-1） |
| §1 表：取消 T0.4 凭据清点、降级制品哈希 | 拒绝（§4-5） |
| §1 表：war/jar 双指针快照 + `customerReply` 机械模板 | 拒绝（§4-4） |
| §5 部署步骤（build + 重启生产） | 拒绝执行（§4-6） |

## 3. 新并入任务的摘要

完整规格写在 `20-phase1-quick.md`（S2 改动点第 5 项、S8、S9 三节）。这里只记要点与依赖。

### 3.1 S2 第 5 项：物理路径校验（realpath）

`server/src/tools/code_search.ts` 的 `isInside`（第 415–419 行；调用点 `resolveRepoFile` 第 462 行、`read_file_lines` 第 492 行、scope 根上溯第 614 行）与 `src/tools/sandbox.ts` 的 `validatePathInRepo`（第 26–29 行）只做 `path.resolve` 后的字符串前缀比对，符号链接与 Windows 目录连接点（Junction）可以绕过。修法：先 `fs.realpathSync.native` 再比较；候选不存在（新建文件）时取最近存在祖先做 realpath 后拼接剩余段；失败回退字符串比较。测试用 `os.tmpdir()` 下的 junction 越界用例，服务端与客户端两侧都要有；**绝不在真实仓库里建连接点**。

### 3.2 S8：发布词表误杀修复（**必须先于 M2**）

`publication.ts` 第 30 行把任何"长度 ≥3 且含字母"的字符串收进敏感词表（源码里的 `app =`、`vip =`、查询列名都会被收），第 66 行做大小写不敏感的词边界匹配 → 公开答案写"APP/VIP/PDF"即判 `internal_identifier`，初稿被 `parsePublicDraft` 打回，降级内容也在 `review.ts:189` 被清空。修法：`isPrivateTermCandidate = 长度≥6 或含下划线 或含小写→大写过渡`，外加"用户消息里出现过的纯字母数字 token（无大小写过渡）"豁免。**不加白名单、不动 `PRIVATE_PATTERNS`、不改匹配方式**；现有 3 项 publication 测试必须保持绿。

### 3.3 S9：工具超时记录（S9a）与截图落盘去重（S9b）

- **S9a**：`core.ts` 第 165 行 20 秒超时只 reject，第 169 行 catch 调 `this.result()` 未传 `notExecuted` → `evidence.outcome` 误记 `failed`（应为 `not_executed`）。修法：超时错误带标记、catch 读出并传入；新增 `toolTimeoutMs?: number`（默认 20000）供测试注入；普通异常行为不变。
- **S9b**：`server/src/llm.ts` 的 `saveBase64ImagesToDiskAndExtractPaths`（第 308–348 行）每次请求为全部历史消息重写图片（时间戳+随机名，第 332 行）。修法：按内容 SHA-256 前 16 位命名（`img_<hash16>.<ext>`），已存在则复用。`_savedLocalPath` 只用于服务端日志摘要（第 365 行），发往中转的消息在第 269 行已剥离，所以修复的理由是**磁盘写放大与审计日志路径不稳定**，与提示缓存无关。

## 4. 拒绝清单（6 条）

| # | 报告建议 | 拒绝理由 |
|---|---|---|
| 1 | `challengeSchema` 问题数上限 5→20 | 反证提示词仍写"最多列 5 个问题"（`review.ts:25`），放宽 schema 不会让模型多列；且非空问题一律 needs_revision（`:164-167`），放宽只扩大拒绝面。 |
| 2 | 硬编码 12 分钟 `maxInvestigationMs` | 与 D1 冲突（15 分钟上限、到点冻结、人工不限次数 +5 分钟）；预算必须走 R2 的 `budget`/`RunState` 设计，不是单个常量。 |
| 3 | 只用 glob 对 `prod-config` 设门 | 泄露有三条路径：`search_code`、`read_file_lines`、图谱 `references.json`。S2 覆盖四个入口 + 索引器 + 图谱重建；只改 glob 会漏掉后两条。 |
| 4 | `customerReply` 机械模板拼接 | 该设计针对的是过期文档 `docs/plan-gemini-high-v2.md`；v3 没有这个设计。话术约束由 R1 的按断言发布覆盖。 |
| 5 | 取消 T0.4 凭据清点、降级制品哈希 | T0.4 全只读、不读凭据值，是 G1 轮换清单的唯一输入；"拦得住读取"不能替代"已经读过什么"的暴露面结论。制品标识（V1）同理。 |
| 6 | 报告 §5 的部署步骤 | `npm run --prefix server start` 会重启生产服务端（红线）；dist 重建与切换只在 G0/G9 窗口内做。执行模型只提交源码与测试。 |

## 5. 审计报告核实记录（2026-10-14）

1. **逐符号检索零命中**：`sanitizeReviewQuestionContent`、`applyPartialRetentionFromChallenge`、`PUBLIC_SAFE_TERMS`、`userProvidedTerms`、`maxInvestigationMs` 在源码与测试里都不存在（排除 `node_modules`）。
2. **工作区状态**：HEAD = `636adda`，`git status --short` 只有 `docs/exec-plan-v3/` 下的变更；它声称改过的文件没有一个被改过。
3. **测试数对不上**（2026-10-14 实测，全绿）：总 174 项 / 18 个文件 / 33 个套件；报告称 175 项 / 17 个文件。逐文件：`publication.test.ts` 3 项（报告 4）、`review_recovery.test.ts` 15 项（报告 17）、`finalization.test.ts` 5 项（报告 6）。
4. **报告 §1 声称"已修复"的三项也未发生**：`EXCLUDE_GLOBS` 仍无 `prod-config`/`*.bak`；`sync_manager.ts` 的 `reset --hard` 仍在（第 104/109 行）；提示词里"注明表名/路径行号"的冲突指令仍在。这三项正是 S1/S2/S3 的任务内容。
5. **结论**：报告描述的不是这份工作副本（或在别处改了没带回来）。它的价值是缺陷诊断；修改清单不能采信。**报告 §5 的命令一律不执行。**

## 6. 执行顺序与关口速查

- **S5 最先**；**S8 必须先于 M2**（否则基准里的"误拦"混着词表噪声）；**M3 先于任何复核提示词改写**；**R5 先于 R1–R4**（它是回滚手段）；M1 随时可做（不花钱）；V1 等 G6，与 Phase 1 并行。
- S1、S2、S4、S7、S8、S9 互相独立；S9a 与 S7 同改 `core.ts`，建议相邻提交。
- 日常执行 = 源码 + 测试 + 提交；**dist 重建、服务重启只在 G0/G9 窗口**。S2-5/S8/S9 改的文件都在发布门禁哈希名单里（`40-phase3-review-delivery.md` 开头），本轮不发布，`STATUS.md` 记一笔即可（同 S3）。
- 关口表、任务表、偏差与等待人：以 `STATUS.md` 为准。
