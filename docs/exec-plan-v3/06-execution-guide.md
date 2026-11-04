# 06 · 执行模型实操指南与避坑清单（v3.1 评估定稿）

> **用途**：本文件是对 `docs/exec-plan-v3/` 重组方案（v3.1）进行源码级交叉核验后的**最终执行指令单**。执行模型开工前必须读完 `00-README.md` → `05-change-plan.md` → **本文件** → `STATUS.md`，再按阶段推进。**当阶段文件细节与本文件的“代码级避坑指令”冲突时，以本文件为准。**

---

## 1. 铁律与安全红线（违反任一条立即停机汇报）

1. **禁止触碰生产与发布管线**
   - 严禁运行 `npm run build:exe`、严禁写入 `server/data/releases/`。
   - 严禁停止、重启或修改端口 `8600` 的生产服务端；**严禁执行外部审计报告 §5 的部署与重启命令**。
   - 日常开发只改源码、跑单测、提交 git；`dist` 重建与服务重启**仅限 G0 / G9 人工关口窗口**。
2. **禁止破坏外部目录与本机配置**
   - 严禁修改 `D:\skt_project`、`D:\skt_project_backup_*`、`D:\skt_project_fresh_*`、`C:\Users\skt\git\*` 下的任何文件。
   - 读取 `D:\skt_project` 镜像时只用只读命令，所有 `git` 命令一律加 `--no-optional-locks`。
   - 严禁运行 `scripts/e2e_first_launch_key_binding.mjs`（会删真实 `~/.xkang/config.json`）和 `scripts/e2e_device_binding.mjs`（会删服务端数据）。
   - 代码图谱重建实验必须在**隔离临时目录**进行，严禁覆盖 `server/data/codegraph/`。
3. **保密与隐私底线**
   - 严禁将任何密码、密钥、Token、连接串的**值**打印到终端、日志、提交、`STATUS.md` 或对话中（只报 `文件:行号:键名`）。
   - 严禁将客户姓名、电话、证件号、真实订单号写入 git 跟踪文件、`STATUS.md` 或对话（评测与工单数据只放 git 忽略目录 `tests/eval/reports/**`、`tests/eval/data/**`）。
4. **成本与质量门禁**
   - 任何会调用付费模型的任务，必须先报预算（**关口 G3**），每次调用必须写入台账 `tests/eval/reports/exec-v3/usage-ledger.jsonl`，且必须设置单次调用超时。单任务累计超 10M token 立即暂停请示。
   - 每个任务先写测试再改实现；每次提交前必须通过以下 4 条检查：
     ```bash
     npm test
     npm run typecheck
     npm run typecheck:test
     cd server && npx tsc --noEmit
     ```
   - 每完成一个任务或发现计划与现实不符，**立即更新 `STATUS.md`**（不一致先写“偏差”栏再继续）；每阶段结束更新 `memory/memory.md`。

---

## 2. 全局执行顺序与硬依赖

必须严格遵守以下拓扑顺序，不得颠倒关键依赖：

### Step 1：Phase 0（现场保护与材料请求，零模型费用）
1. **`T0.1`**：核对 `HEAD` 为 `636adda`，跑通 174 项测试与 3 项类型检查；创建并切换到分支 `accuracy-v3`，提交 `docs/exec-plan-v3/` 计划文件。
2. **`T0.2`**：核对 `tests/eval/reports/mirror-reclone-20261010-111550/preserved-local-changes/` 三份保全文件 SHA-256，写 `README.md` 留痕。
3. **`T0.4`**：只读扫描 `D:\skt_project` 凭据暴露面（只取路径与键名，严禁取键值），实测验证三条泄露路径（`search_code`、`read_file_lines`、`codegraph_explore`），产出 `credential-surface.csv` 与 `credential-exposure-report.md`（触发 **G1**）。
4. **`T0.5`**：核对 `docs/exec-plan-v3/requests/` 下三份请求信（按 `list_log_apps` 补全服务名单），交由用户转发（触发 **G0/G1/G6/G7/G8**），更新 `STATUS.md` 等待栏。

### Step 2：Phase 1（低风险快速改动，S3/S7 回归实验外零模型费用）
1. **`S5`（必须最先做）**：实现 `server/src/stats.ts`（Clopper-Pearson 单侧上下界、Wilson 双侧区间，对齐 10 个锚点值）、`scripts/eval/sample_size.ts` 与 `usage_ledger.ts`。
2. **`S8`（必须先于 M2）**：修复 `server/src/agent/publication.ts` 的 `collectPrivateTerms` 词表误杀（形态规则 + 用户自带词豁免）。
3. **`S1`**：改造 `server/src/codegraph/sync_manager.ts`，彻底摘除 `git reset --hard`，脏工作区跳过并输出 `mirror-health.json`。随后完成 **`T0.3`**（固化镜像状态 JSON + 编写 S1 重启窗口手册 `restart-for-s1-runbook.md`）。
4. **`S2`**：新建 `server/src/codegraph/path_policy.ts` 统一排除 `prod-config` 及 `*.bak/*.old/*.orig`（覆盖 `search_code`、`resolveRepoFile`、`indexer.ts`、`git_inspect`），并完成**第 5 项物理路径校验（`isInside` 与 `validatePathInRepo` 的 `realpathSync.native` 改造 + `os.tmpdir()` junction 测试）**。完成后复跑 `T0.4` 第 3 步确认三条路径均变为“不可达”。
5. **`S4`**：新增 `modelCallTimeoutMs`（默认 240000，非复核调用显式设置，`maxRetries: 1`），`service.ts` 将 `runSignal` 传入 `BusinessModel`。
6. **`S6`**：新增 `server/src/agent/input_guard.ts` 在服务端工具包装层对凭据值做入模脱敏（`***REDACTED:<键名>***`），脱敏事件写入台账。
7. **`S7` + `S9`（建议相邻提交，均改 `core.ts`）**：
   - `S7`：修复 `validateReview` 中只读查询被判 `performed_action`、修复 `core.ts:199` 硬编码动作工具列表、剥离复核材料中的截图 base64、`reviewAnswer` 的 `timeoutMs` 改必填、补齐格式错误字段路径提示。
   - `S9a`：`core.ts:165/169` 工具超时错误带 `notExecuted = true` 标记，使 `evidence.outcome` 记为 `'not_executed'`；新增可选 `toolTimeoutMs` 供测试注入。
   - `S9b`：`server/src/llm.ts` 的 `saveBase64ImagesToDiskAndExtractPaths` 改为按内容 SHA-256 前 16 位命名（`img_<hash16>.<ext>`），已存在则跳过写盘直接复用路径，并导出该函数供单测调用。
8. **`S3`**：清理 `investigation_prompt.ts` 与 `skills.ts` 中不存在/已移除的工具描述与公开输出冲突指令（模型回归实验需先报 **G3** 预算）。

### Step 3：Phase 2（失败归因与复核基准）
1. **`M1`（不花钱，可随时启动）**：用 `scan_run_evidence.ts` 与 `build_attribution_sheet.ts` 对既有 120 次运行做失败归因，产出 `attribution.tsv` 与 20 条开发抽查包（**G2**）。
2. **`M2`（依赖 S5、S7、S8）**：抽取受控用例并补充脱敏后的真实历史案例，建立复核基准，在改复核前跑出 `baseline.json`（先报 **G3** 预算）。
3. **`M3`（依赖 M2、S7；必须在任何复核提示词改写前完成）**：新增 `reviewReasoningEffort` 配置，在 M2 基准上串行对照 `default / low / high` 三档，选定复核思考档位（先报 **G3** 预算）。
4. **`M4`（依赖 S5）**：实现盲评与打分统计工具链（`make_blind_pack.ts`、`grade_sheet.ts`、`agreement.ts`、`workbook.ts`）。

### Step 4：Phase 3 & Phase 4（复核交付重构与版本可信度）
- **Phase 3 顺序**：**`R5`（特性开关骨架，默认全 `false`）必须最先落地** → `R1`（按断言+条件粒度部分发布，需 **G5** 批准 + M2 回归）→ `R2`（15 分钟预算、安全点冻结、`/continue` 不限次 +5 分钟、线缆 `status` 枚举值保持不变）→ `R3`（前端与 TUI 续查交互，先存档 UI 快照基线）→ `R4`（反馈绑定 `turn_id`、去除明文 bearer token 与全量私有上下文）。
- **Phase 4 顺序**：`V1`（跟进 **G6** 部署清单）→ `V2`（基于 `mirror-health.json` 与清单计算“已核准/推定/未知”三档，落盘 `version-trust.json`）→ `V3`（四大代码工具输出加版本戳，`CodeGraphService.rebuildIndex()` 内置同步写入 `snapshot-manifest.json`）→ `V4`（运行起点 `runPin` 版本漂移检测、`git_inspect` 新增 `show` action、未知档位强制数据核对模式）。

### Step 5：Phase 5（真实工单摸底）
- `P1`（基于 **G7** 构建并冻结 30～40 单分层题集）→ `P2`（摸底 A：用 `636adda` 隔离构建跑 1 轮，需 **G3+G4** 单独批准约 180M token 预算）→ `P3`（摸底 B：用候选构建跑 1 轮对照）→ `P4`（请开发盲评 **G8**，重算金标准指标并用 `sample_size.ts` 反推正式验收样本量；**报告严禁宣称“已达上线正确率”**）。

---

## 3. 代码级避坑指令（评估发现的 5 处关键细节，执行时必须遵守）

以下 5 处是计划文本与当前代码/单测直接碰撞的地方，执行模型在编写对应任务代码时必须按此处理：

### 避坑 1：`S7` 第 4 项（`reviewAnswer` 的 `timeoutMs` 改必填）——必须同步更新 13 处测试与 2 处脚本调用
- **原因**：`server/src/agent/review.ts:91` 改为必填并在缺失 `options?.timeoutMs` 时抛错后，现有的无参调用会直接崩溃。
- **必做动作**：
  1. 在 `tests/server/review_recovery.test.ts` 中，将未传 `options` 的 **12 处** `reviewAnswer(...)` 调用补齐第 7 参数 `{ timeoutMs: 60000 }`；
  2. 在 `tests/client/finalization.test.ts:54` 中，将 `reviewAnswer(...)` 调用补齐 `{ timeoutMs: 60000 }`；
  3. 在 `scripts/eval/business_acceptance.ts:65` 与 `scripts/eval/review_optimization.ts:57` 中，补齐 `{ timeoutMs: config.answerReviewTimeoutMs }`（修复此前评测脚本静默退回 60s 的历史漏传）。

### 避坑 2：`S7` 第 1 项（`validateReview` 的 `performed_action` 修复）——如何在“不改提示词”前提下兼顾防误拦与防漏检
- **原因**：`S7` 规定**不得修改提示词措辞**（留待 `M3` 之后）。因此复核模型在引文阶段仍可能输出 `block.kind === 'performed_action'`。若在 `validateReview`（`review.ts:84`）里简单删掉校验或对所有只读工具放行，会导致 `review_optimization.ts:20` 的 `reservation_false_action`（“我已通知财务退回押金”）存在漏检风险；若不放行只读工具，则服务端永远没有 `write_file/edit_file/run_powershell`，任何标为 `performed_action` 的句子必死。
- **必做动作**：在 `validateReview` 中结合 `units`（通过 `block.blockId` 取回待核验原句文本）与 `source?.name` 做确定性区分：
  - 定义服务端只读工具集：`lookup_order`、`company_db_query`、`search_code`、`read_file_lines`、`codegraph_explore`、`git_inspect`、`search_logs`、`list_log_apps`；
  - 当 `block.kind === 'performed_action'` 时，仅当引用的 `source?.name` 属于上述只读工具集，**且**该 `blockId` 对应的原句文本**不包含**写操作或外部动作声明（如 `/已(?:经)?(?:为您|为你|帮您)?(?:通知|退回|退款|修改|写入|删除|发送|重置|提交|办理|更改|取消)/`）时，将其视为只读查证事实放行；
  - 若原句声称了上述写操作/外部动作（如“我已通知财务退回押金”），仍要求具备写动作工具执行记录（在服务端必然拦截并报 `没有动作执行记录`）。

### 避坑 3：`S7` 第 3 项（剥离复核材料中的图片 base64）——找准 `packet.questions` 位置并做好宽高兜底
- **原因**：`review.ts:109` 中用户消息通过 `original = history.filter(...).map(m => ({ role: m.role, content: m.content }))` 进入 `packet.questions`。多模态截图就在 `m.content` 数组的 `{ type: 'image_url', image_url: { url: 'data:image/...' } }` 中。
- **必做动作**：
  1. 映射清洗 `original`（`packet.questions`）中的 `m.content`：若为数组，将其中的 `image_url`（或含 `data:image/` 的内容）替换为文本占位；同时对 `packet.evidence` 中可能出现的 `data:image/...;base64,[A-Za-z0-9+/=]{200,}` 做正则替换兜底；
  2. 解析 PNG/JPEG 头部宽高若失败（例如单测中用合成字符串构造的假 base64），回退为显示估算大小（如 `[截图 1：约 150KB，已省略二进制内容]`），确保 `estimateTokens` 对任意大图均保持常数级 token 消耗。

### 避坑 4：`S8`（`collectPrivateTerms` 用户自带词豁免）——大小写对齐与单号长度上限
- **原因**：
  1. `publication.ts:30` 的 `add(value)` 存入 `terms` 的是未转小写的原词，而豁免集合存的是小写；
  2. 真实外部供应商单号、流水号（字母+数字组合）常达 13～24 位，若豁免正则卡在 `{2,12}`，长单号仍会被 `text.length >= 6` 收进私有词表并误拦。
- **必做动作**：
  1. 在 `add(value)` 开头判断豁免时，必须使用 `if (userExemptTerms.has(text.toLowerCase())) return;`（放在第 30 行 `isPrivateTermCandidate` 之前，第 32 行源码文件名后缀分支保持不受豁免影响或仅对非文件名豁免）；
  2. 提取用户消息（`role === 'user' && !isReminderMessage(m)`）中的纯字母数字 token 时，保留“**不含 `[a-z][A-Z]` 小写→大写过渡**”的防注入规则，将长度范围设为 `/^[A-Za-z0-9]{2,32}$/`。

### 避坑 5：`S2` 第 5 项（`realpathSync.native` 物理路径校验）——未存在路径的 `..` 防护与返回值契约
- **原因**：`validatePathInRepo`（`src/tools/sandbox.ts`）面对尚未创建的新文件路径时，需向上回溯到最近存在的祖先目录做 `realpathSync.native`。
- **必做动作**：
  1. 回溯前必须先用 `path.resolve(resolvedRepoRoot, cleanInput)` 归一化路径；找到最近存在祖先 `existingAncestor` 并算出 `realAncestor = fs.realpathSync.native(existingAncestor)` 后，用 `path.resolve(realAncestor, relativeFromAncestor)` 还原候选物理路径，再与 `realRoot = fs.realpathSync.native(resolvedRepoRoot)` 做小写前缀比对；
  2. 物理路径比对通过后，`validatePathInRepo` 返回的 `{ safePath, relativePath }` **继续沿用原有的 `resolvedTarget` 与 `path.relative(resolvedRepoRoot, resolvedTarget)`**，不要返回展开软链/短文件名（如 Windows `RUNNER~1`）后的路径，以免破坏上层调用方与既有测试对相对路径格式的预期。

---

## 4. 现场小偏差说明（T0.1 / T0.3 执行时顺手处理）

- **端口 8600 状态核实**：`00-README.md` §3 记录端口 8600 正在运行（PID 33700），而 `memory/memory.md`（2026-10-13）记录 PID 36944 已终止、8600 处于空闲。执行 `T0.3` 时用只读命令查看当前 8600 实际监听情况，若与 README 描述不同，按规则先在 `STATUS.md` 的“偏差”栏记一笔即可；无论 8600 当前是否监听，在未获 **G0/G9** 批准前均不得启动或重启 8600 服务。
