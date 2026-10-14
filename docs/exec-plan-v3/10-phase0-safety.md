# Phase 0 · 现场保护与材料请求

目标：不改任何业务行为，先把现场的风险收口、把需要人提供的材料第一天发出去。全部任务不花模型费用。

---

## T0.1 验证基线并建立工作分支

**目标**：确认从已知状态出发。

**步骤**
1. `git rev-parse baseline-20261010` 应以 `dc08edf` 开头。`git status --short` 除了 `docs/exec-plan-v3/` 外应为空。
2. 运行并记录结果：`npm test`（期望 170 项全部通过，它会先执行 `npm run build:core`）、`npm run typecheck`、`npm run typecheck:test`、`cd server && npx tsc --noEmit`。
3. `git switch -c accuracy-v3`，把 `docs/exec-plan-v3/` 提交（信息：`docs: execution plan v3`）。

**验收**：测试 170/170，三项类型检查无报错，分支存在。基线测试不通过就停止并汇报，不要先修。

---

## T0.2 保全证据核对

**依据**：镜像里两个未提交文件的内容是不可再生的。现有保留位置：`tests/eval/reports/mirror-reclone-20261010-111550/preserved-local-changes/`（3 个文件，sha256 记在同目录上级的 `operation.json`）；以及开发提交 `66bf877fc`（`C:\Users\skt\git\skt_cxy`，dev 分支，已在 `origin/dev`）。

**步骤**
1. 对三个保留文件算 sha256，与 `operation.json` 的 `preservedFiles` 逐项比对（大小写不敏感）。
2. 只读验证开发提交：`git --no-optional-locks -C C:/Users/skt/git/skt_cxy show --stat 66bf877fc` 应显示 3 个文件、108 行新增；用任意方法确认保留补丁的每一行新增内容都在该提交里（基线核对时：保留补丁去重后 57 行新增，全部包含在该提交的 79 行新增里）。
3. 在保留目录写 `README.md`：说明内容的两处位置、哈希、核对日期。**不要删除、移动、覆盖该目录**，不要清理 `tests/eval/reports/` 下的任何目录。

**验收**：README 存在；哈希一致；记录到 `STATUS.md`。

---

## T0.3 镜像现状固化与换装手册 **[关口 G0]**

**目标**：给出可执行、可回滚的换装手册；查清"文件被占用"的原因；不执行任何写操作。

**步骤（全部只读）**
1. 记录镜像状态到 `tests/eval/reports/exec-v3/mirror-state-<日期>.json`：17 个子仓库各自的分支、HEAD、最近标签（`git describe --tags --abbrev=0`）、HEAD 是否正好在该标签、未提交文件名列表（只要文件名）、是否浅克隆、远端分支数量（远端 URL 里的凭据必须遮盖成 `***`）。所有 git 命令加 `--no-optional-locks`。
2. 对 `D:\skt_project_fresh_20261010-111550` 做同样记录，并列出它与镜像在每个仓库上的差异（HEAD 是否相同、各自的提交数）。
3. 找占用者的候选清单（只查看，不结束任何进程）：用 PowerShell `Get-CimInstance Win32_Process` 列出命令行或可执行路径含 `skt_project` 的进程；列出 `idea64.exe`、`Code.exe`、`git.exe`、`node.exe`（区分服务端 `D:\web_pro\xkang-tui\server` 和其他）；检查 Sysinternals `handle.exe` 是否可用（`where handle`），可用则只做查询（`handle.exe -nobanner D:\skt_project`）。记录**判断依据**，不要仅凭猜测下结论。
4. 写 `tests/eval/reports/exec-v3/mirror-swap-runbook.md`，内容至少包括：
   - 前置：S1 已合入并构建；确认服务端运行方式（本机一次观察是 `node dist/index.js`，工作目录 `D:\web_pro\xkang-tui\server`，端口 8600）；先在完整克隆里 `git pull --ff-only` 到最新 P 标签并确认工作区干净。
   - 停机窗口内的顺序：停服务端 → 关闭可能占用的 IDE 窗口 → 重命名 `D:\skt_project` 为 `D:\skt_project_old_<时间>` → 重命名完整克隆为 `D:\skt_project` → 检查 `git status` 干净 → 重建代码图谱（可复用审计目录里的 `build-staged-graph.mjs`）→ 用含 S1 的构建启动服务端 → 查看 `mirror-health.json`（S1 产物）全部为干净。
   - 回滚：反向重命名；旧目录至少保留 7 天，任何情况下都不要删除它。
   - 失败处理：重命名失败就停在原状，不要用 `robocopy /MIR`、`xcopy` 或删除重建的方式绕过。
5. 把状态摘要和手册路径写进 `STATUS.md` 的"等待"一栏，向用户说明需要一个停机窗口。

**验收**：状态文件、运行手册存在；手册的每一步命令可直接复制执行；没有任何写操作发生。**得到用户批准之前不执行手册。**

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
3. 确认当前工具能不能读到它们：在一个临时测试里直接调用 `executeSearchCode`（`server/src/tools/code_search.ts`），用无害关键词（如 `datasource`）、`scope: 'backend'`，只记录**返回了哪些文件路径**。结果写成"可检索 / 不可检索"。
4. 确定暴露窗口起点：`server/data/xkang.db` 的 `audit_logs` 里第一次出现 `search_code` 工具调用的日期（只取日期与次数）。
5. 写 `credential-exposure-report.md`：
   - 结论用"可能已暴露"：只要凭据文件在检索范围内、且存在对应工具调用，就按已发给模型中转处理；
   - 给出建议的轮换清单（系统类别、数量、优先级：数据库和支付商户密钥最高）；
   - 报告里不得出现任何值。生成后用 `rg -n "[A-Za-z0-9+/=_-]{24,}"` 扫一遍报告，应无命中（路径里的长字符串要先排除）。

**验收**：三个产物（`credential-surface.csv`、`credential-exposure-report.md`、检索可达性结论）存在，扫描无值。**[关口 G1]**：把报告交给用户转负责人，执行模型不做轮换。

**依赖**：无（但 S2 完成后要重做第 3 步以验证排除生效）。

---

## T0.5 向人提出材料请求（第一天完成）

**目标**：把有等待时间的需求尽早发出去。用 `90-appendix.md` 里的模板，生成三份请求文本，交给用户转发。

1. **给开发（G6、G8）**：
   - 每个线上服务的当前部署版本：服务名、运行入口、制品标识（war/jar 的 sha256 或镜像摘要）、对应 commit 或 P 标签、生效时间；
   - 确认"P* 标签 = 已发布到生产"这个约定，以及哪些仓库没有标签、怎么判断；
   - 确认"现行实现地图"：`skt_cxy` 与 `skt_dpxt_background` 同名类（296 个）分别服务哪些业务；`order/orderNew`、`invoice/invoiceNew`、`hotel/hotelNew`、`entityOld` 的现行与历史关系；各 `*_old` 表的含义；
   - 业务概念对照：票务状态与资金状态、应收与实收、月结与现结、受理与到账、生成通知与实际送达、预订失败与出单失败、保留配置与当前有效；
   - 安排盲评时间（摸底后每条约 5 分钟，共 30～40 条）。
2. **给客服负责人（G7）**：
   - 导出 60 条以上近期真实工单（我们会筛到 30～40 条），含问题原文、附件、客服当时的处理结果；
   - 每条标注"核心诉求"一句话和业务线；
   - 导出格式见附录模板 B2；说明数据只放在本机被忽略的目录，不进入代码仓库。
3. **给运维/负责人（G0、G1）**：
   - 停机窗口（建议 30 分钟）；
   - 凭据轮换清单（T0.4 的结果）；
   - 现网 war/jar 的 sha256 或镜像摘要导出方式。

**验收**：三份请求文本写入 `docs/exec-plan-v3/requests/`（不含个人信息与密钥），并向用户说明各自需要谁、截止在哪。收到材料后在 `STATUS.md` 记录日期。
