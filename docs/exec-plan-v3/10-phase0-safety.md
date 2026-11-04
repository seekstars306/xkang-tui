# Phase 0 · 现场保护与材料请求

目标：不改任何业务行为，先把现场的风险收口、把需要人提供的材料第一天发出去。全部任务不花模型费用。

> **2026-10-14 修订说明**：镜像换装已经在 10-12 完成（保留根目录、切换子目录），原 T0.3 的"换装手册"作废，已改写为只读的现状固化 + "让 S1 生效"的窗口手册。原 T0.2 的前提（补丁只在 dev、main 没有）也已过期，保留一次哈希核对即可。

---

## T0.1 验证基线并建立工作分支

**目标**：确认从已知状态出发。

**步骤**
1. `git rev-parse HEAD` 应以 `636adda` 开头（这是执行基线；标签 `baseline-20261010` 指向更早的 `dc08edf`，只作历史参照）。`git status --short` 里**只应出现 `docs/exec-plan-v3/` 下**的修改与新增（本计划的修订），不应有其它改动。
2. 运行并记录结果：`npm test`（期望 174 项全部通过，它会先执行 `npm run build:core`）、`npm run typecheck`、`npm run typecheck:test`、`cd server && npx tsc --noEmit`。
   **这一组已经在 2026-10-14 验证过是绿的**（174/174 通过，三项类型检查无输出），所以如果不通过，说明是你自己改出来的问题，不是基线的问题。
3. `git switch -c accuracy-v3`，把 `docs/exec-plan-v3/` 的修订与新文件一次性提交（信息：`docs: execution plan v3`）。

**验收**：测试 174/174，三项类型检查无报错，分支存在，`git status` 干净。基线测试不通过就停止并汇报，不要先修。

---

## T0.2 保全证据核对

**依据**：`tests/eval/reports/mirror-reclone-20261010-111550/preserved-local-changes/` 的三份副本是历史证据，内容早先已随开发提交 `66bf877fc` 进入 `skt_cxy` main（**实测：`66bf877fc` 是镜像 `skt_cxy` HEAD 的祖先**），所以"只此一份"的风险已经不成立。核对只是为了留痕，不需要再做补丁逐行比对。

**步骤**
1. 对三份保留文件算 sha256，与 `operation.json` 的 `preservedFiles` 逐项比对（大小写不敏感）。
2. 在该目录写 `README.md`：内容来源、两处副本位置、哈希、核对日期、以及"`66bf877fc` 已在 main"这一结论。**不要删除、移动、覆盖该目录**，不要清理 `tests/eval/reports/` 下的任何目录。
3. 在 `STATUS.md` 记录结论。

**验收**：README 存在；哈希一致。核对不上就停止并汇报，不要"修"文件。

---

## T0.3 镜像现状固化（只读）与"让 S1 生效"的窗口手册 **[关口 G0]**

**目标**：把当前镜像状态固化成机器可读的一份记录（Phase 4 的输入端），并给用户一份**唯一还需要停机窗口的动作**：让 S1（安全同步）在生产服务上生效。不执行任何写操作。

**步骤（全部只读）**
1. 写一个小脚本（放在 `tests/eval/reports/exec-v3/` 下，不进 git 跟踪范围之外），记录每个子仓库：相对路径、分支、HEAD、`git describe --tags --abbrev=0` 的最近标签、**HEAD 是否恰好等于该标签**、未提交文件名列表（只要文件名）、是否有 `.git/shallow`、远端分支数量、远端 URL（**必须先遮盖凭据**）。输出 `mirror-state-<日期>.json`。所有 git 命令加 `--no-optional-locks`，禁止 `git fetch`/`git pull`/`git status` 之外的写操作（`status` 只读，但为稳妥一律用 `git --no-optional-locks status --porcelain`）。
   - 2026-10-14 的实测结果可直接作为对照基线：17 个仓库全部 `main`、全部干净、全部非浅克隆；**HEAD 恰好等于最新标签的只有 7 个**（`logmanage` P1.0.9、`skt_cxy` P1.2.1、`skt_dpxt_background` P1.2.7、`skt_project_sms` P1.0.6、`sktprojecthotel` P1.1.18、`skt_webview` P1.3.2、`skt-remote` P1.0.7）；有标签但 HEAD 已越过的是 `ibemonitor`、`payment-service`（都是 P1.0.9/P1.0.5）、以及 `prod-config`（标签是 `T1.0.0`，**不是 P 前缀**）；**其余 7 个仓库一个标签都没有**（`skt-back-hotel`、`skt-back-user`、`skt_dpxt_mobile`、`skt_dpxt_pc`、`skt_new_webview`、`skt_zfgwjp_mobile`、`skt-remote-sdk`）。
2. 记录 `prod-config` 的排除状态：`core.sparseCheckout` 取值、`git ls-files -v | grep '^S'` 的条数（实测 16 条 skip-worktree）。**这条决定了任何"清理镜像"动作都不能对它做全量硬重置。**
3. 记录占用者候选（只查看，不结束任何进程）：PowerShell `Get-CimInstance Win32_Process` 里命令行或可执行路径含 `skt_project` 的进程；`handle.exe` 若可用（`where handle`）则只查询。**这一步现在只是存档，不再有"必须查清才能换装"的目的。**
4. 写 `tests/eval/reports/exec-v3/restart-for-s1-runbook.md`，只覆盖一件事——**在制品上启用 S1 的安全同步**：
   - 前置：S1 已合入 `accuracy-v3` 并通过测试；已按 S1 的说明在隔离实例（8691–8699，`CODE_SYNC_ENABLED=false` 之外的专门用例）验证过"脏工作区不再被硬重置"。
   - 窗口内顺序：`npm run build`（构建 dist，**不要**跑 `build:exe`）→ 停服务端（先看 `server/data/service-lifecycle.jsonl` 确认当前实例的启动时间与 PID）→ 用新构建启动 → 检查启动日志与 `/healthz` → 触发一次 `POST /admin/codegraph/sync`（需要管理员令牌）→ 查看 S1 产物里的镜像健康记录，确认 17 个仓库全部"干净"或明确标出脏项 → 确认服务端功能正常（发起一次真实只读查询）。
   - 回滚：`git` 回到上一个提交、用原来的 `dist` 启动。**回滚前先把旧 `dist` 备份到一个临时目录**（dist 不在 git 里）。
   - 失败处理：启动失败就退回旧 `dist`，不要在窗口里临场改代码。
5. 状态摘要与两个产物路径写进 `STATUS.md` 的"等待"一栏，向用户说明"这次窗口只需要重启，不再需要换镜像"。

**验收**：`mirror-state-<日期>.json`、`restart-for-s1-runbook.md` 存在；手册每一步命令可直接复制执行；**没有任何写操作发生**。得到用户批准之前不执行手册。

**依赖**：S1（Phase 1）。

---

## T0.4 凭据暴露面清点（只读）

**目标**：知道哪些凭据可能已经经过模型请求，给各系统负责人一份轮换清单。**不尝试验证凭据是否有效，不使用任何凭据，不修改任何凭据。**

**步骤**
1. 用仓库自带的 ripgrep（`node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe`，如路径不同用 `rg --version` 确认）枚举 `D:\skt_project` 里可能含凭据的文件，只输出路径：
   - `application*.yml|yaml`、`*.properties`、`bootstrap*.yml`、`*.env`、`.env*`、`docker-compose*.yml`、`*.sh`（含 `export`/`ENV` 行的）；
   - `*.pem|*.key|*.jks|*.p12|*.pfx`、`id_rsa*`；
   - `*.bak*`、`*.old`、`*.jar.bak`；
   - `*.sql` 中含 `GRANT`/`IDENTIFIED BY` 的。
   按仓库和顶层目录汇总数量到 `credential-surface.csv`。
2. 对这些文件，只提取**键名**（不是值）：写一个小脚本，匹配 `(password|passwd|pwd|secret|token|credential|access[_-]?key|api[_-]?key|private[_-]?key|app[_-]?secret|sign[_-]?key|salt)` 出现在键位置的行，输出 `文件:行号:键名`，**不得输出等号或冒号之后的任何内容**。汇总成"系统 → 凭据类别 → 文件数"表（数据库、Redis、MQ、支付商户密钥、短信、微信、内部令牌、其他）。
3. 确认当前工具能不能读到它们。**三条路径都要验，各自写成"可达 / 不可达"**，只要记录返回的文件路径，不要把文件内容抄进报告：
   - `executeSearchCode`（`server/src/tools/code_search.ts`）：无害关键词（如 `datasource`）、`scope: 'backend'`；
   - `executeReadFileLines`：传入一个 `skt-back/prod-config/**/application.yml` 的相对路径，看是否返回正文；
   - `executeCodeGraph`（`queryType='references'`）：对 `skt-back/prod-config` 下确实出现在图谱里的符号查询。**已知图谱 `references.json` 里就有 `skt-back\prod-config\cxy-transfer\application.yml` 和 `skt-back\prod-config\nacos\application.properties`**，所以这条路径预期是"可达"，照实记录即可。
   这三条在 S2 完成后必须重跑一次，用来验证排除真的生效。
4. 确定暴露窗口起点：`server/data/xkang.db` 的 `audit_logs` 里第一次出现 `search_code` 工具调用的日期（只取日期与次数）。
5. 写 `credential-exposure-report.md`：
   - 结论用"可能已暴露"：只要凭据文件在检索范围内、且存在对应工具调用，就按已发给模型中转处理；
   - 给出建议的轮换清单（系统类别、数量、优先级：数据库和支付商户密钥最高）；
   - 报告里不得出现任何值。生成后用 `rg -n "[A-Za-z0-9+/=_-]{24,}"` 扫一遍报告，应无命中（路径里的长字符串要先排除）。

**验收**：三个产物（`credential-surface.csv`、`credential-exposure-report.md`、检索可达性结论）存在，扫描无值。**[关口 G1]**：把报告交给用户转负责人，执行模型不做轮换。

**依赖**：无（但 S2 完成后要重做第 3 步以验证排除生效）。

---

## T0.5 向人提出材料请求（第一天完成）

**目标**：把有等待时间的需求尽早发出去。

**三份请求文本已经起草好了**，放在 `docs/exec-plan-v3/requests/`：
- `R1-dev-G6-G8.md` —— 给开发：版本清单、标签约定、现行实现地图、历史文档名单、业务概念对照、盲评排期（模板 B1，含实测的 17 个仓库标签分布表）；
- `R2-cs-lead-G7.md` —— 给客服负责人：工单导出格式（模板 B2）；
- `R3-ops-G0-G1.md` —— 给运维：重启窗口、凭据轮换清单、制品标识取法（模板 B3）。

**要做的是核对与补齐，不是重新写**：确认名单/数字没变（尤其是 G6 的服务清单要按 `list_log_apps` 的实际返回补全），把 `90-appendix.md` 的模板当参考，然后把三份文本交给用户转发。

**核对时逐项确认**
1. **R1 给开发（G6、G8）**：服务清单要按 `list_log_apps` 在 `cxy` 命名空间下的**实际返回**补全——**每个能查日志的服务都必须有一条**，否则它只能是"版本未知"。其余五项（标签约定、现行实现地图、历史文档名单、业务概念对照、盲评排期）照文本核对。
2. **R2 给客服负责人（G7）**：`core_demand`（核心诉求）那一栏必须在文本里，而且要说清"一句话就够"和"不要为了凑多样性挑题"。
3. **R3 给运维（G0、G1）**：停机窗口的说明要改成"**只需要重启让 S1 生效，不再需要换镜像**"，并指向 `restart-for-s1-runbook.md`（T0.3 的产物）。凭据清单要等 T0.4 出结果后再附上。

**验收**：三份文本已核对（数字与名单与实测一致、不含个人信息与密钥），交给用户转发；在 `STATUS.md` 的"等待人"一栏把 G0/G1/G6/G7/G8 的状态改成"已提出"并记日期。收到材料后在 `STATUS.md` 记录日期。
