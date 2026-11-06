# Phase 4 · 版本可信度

前置：Phase 1 的 S1（安全同步）与 S2（路径排除）已完成——V3 要写进工具结果，V2 要读 S1 的健康产物。

**这一阶段解决的是"模型读到的代码到底是不是线上跑的那一份"**。D2 已定下三档：已核准 / 推定 / 未知。本阶段把它从口号变成可计算的判定和可见的标记。

---

## V1 服务映射与部署清单 **[关口 G6]**

**目标**：拿到"哪个服务现在跑的是哪个版本"的第一手证据。**这是本阶段唯一需要人的一环，越早发出去越好**（请求文本见 `10-phase0-safety.md` 的 T0.5 与 `90-appendix.md` 的模板 B1）。

**依据**
- `skt_cxy` 的 pom **没有** git-commit-id / build-info 插件 → **jar 的哈希无法映射到提交**（已核实）。所以必须同时拿到"制品标识"和"人工登记的提交/标签"两样东西才行。
- 现在有"本地证据显示 P* 标签就是生产版本"的说法，但**那只是约定，没有制品对得上**。D2 的"已核准"要求有部署清单，就是为了堵这个口子。

**产物（本任务要新建这两份，现在都还不存在）**
- `docs/exec-plan-v3/deployment-manifest.example.json` —— schema 与占位样例，**进 git**，不含真实主机名与哈希；
- `tests/eval/reports/exec-v3/deployment-manifest.json` —— 真实清单，**被 git 忽略**（里面会有制品哈希与主机信息）。下面的 JSON 就是 schema，照它写：

```json
{
  "generatedAt": "2026-…",
  "approvedBy": "<开发/运维姓名>",
  "entries": [
    {
      "service": "cxy-web",
      "repo": "skt-back/skt_cxy",
      "environment": "prod",
      "artifact": "war",
      "artifactSha256": "…",
      "commit": "b87627d…",
      "tag": "P1.2.1",
      "effectiveAt": "2026-10-13T…"
    }
  ]
}
```

**步骤**
1. 先核对"P* 标签 = 已发布到生产"这个约定是否成立：请开发对**至少两个**服务回答"当前线上版本对应哪个标签"，然后用制品哈希或部署时间交叉验证。约定被推翻的话，`推定` 这一档的判据要重新定，**先停下来汇报**。
2. 拿 `GET /admin/…` 之外的服务名清单（`list_log_apps` 返回的 `cxy` 命名空间下的应用名）作为覆盖检查表——**每个能查日志的服务都必须在清单里有一条**，否则它只能是"未知"。
3. 落盘并用一个脚本校验：schema 合法、每条都有 `artifactSha256`、`commit` 能在镜像里 `rev-parse` 到。

**验收**：清单覆盖所有可查日志的服务；每条都有制品标识；校验脚本通过；`STATUS.md` 记录收到的日期与缺口。

**红线**：**只有 commit 或只有标签，不足以判为"已核准"。** 必须有制品标识。这是"已核准"与"推定"的唯一区别，不能放宽。

**依赖**：无（可以和 Phase 1 并行推进，人那边有等待时间）。

**关口**：G6。

**风险与回滚**：拿不到制品哈希时，"已核准"这一档就是空的——**这是可接受的结果**，此时全部走"推定/未知"，V4 的数据核对模式兜住风险。不要为了凑出"已核准"而降低要求。

---

## V2 三档判定

**目标**：对每个仓库算出 已核准 / 推定 / 未知，并落成产物供其它环节读取。

**判据（照 D2 实现，不要自行扩大）**
| 档位 | 条件 |
|---|---|
| **已核准** | `deployment-manifest.json` 里有该服务的条目，`commit` 与镜像 HEAD 一致，且制品标识已由人确认 |
| **推定** | 镜像该仓库**工作区干净** 且 **HEAD 恰好等于最新 `P*` 标签**（**只认 `P` 前缀**，`prod-config` 的 `T1.0.0` 不算） |
| **未知** | 其余全部 |

**必须先理解的两件事（实测得出）**
1. **"推定"是易变的**：标签很密，`skt_cxy` 在 2026-10-13 才打出 `P1.2.1`（上一个密集序列是 `P1.1.92`…`P1.1.100`），而同步每 10 分钟跑一次。所以**判定必须带评估时刻**，任何文档里都不许把这个档位写死。
2. **"未知"现在是多数**。2026-10-14 的实测分布：
   - 推定 **7 个**：`logmanage`(P1.0.9)、`skt_cxy`(P1.2.1)、`skt_dpxt_background`(P1.2.7)、`skt_project_sms`(P1.0.6)、`sktprojecthotel`(P1.1.18)、`skt_webview`(P1.3.2)、`skt-remote`(P1.0.7)；
   - 有标签但 HEAD 已越过 **3 个**：`ibemonitor`、`payment-service`、`prod-config`(T1.0.0)；
   - **一个标签都没有 7 个**：`skt-back-hotel`、`skt-back-user`、`skt_dpxt_mobile`、`skt_dpxt_pc`、`skt_new_webview`、`skt_zfgwjp_mobile`、`skt-remote-sdk`。
   报告里要如实呈现这个分布，**不要**把它说成"大部分服务可信"。

**改动点**
- 新增 `server/src/codegraph/version_trust.ts`：
  - `evaluateRepoTrust(repoState, manifestEntry)` → `{ repo, tier, tag, headSha, headDate, dirty, evaluatedAt, reason }`；
  - `evaluateAll(repos, manifest)` → 数组 + 汇总；
  - 读 S1 的 `mirror-health.json` 作为"干净/脏"的输入，**自己不去跑 git 写操作**；
  - 产物写 `server/data/codegraph/version-trust.json`（与 `mirror-health.json`、`stats.json` 同目录）。

**步骤**
1. 先写判定矩阵测试（`tests/server/version_trust.test.ts`）：
   - 干净 + HEAD==最新 P 标签 → `推定`；
   - **脏工作区** + HEAD==标签 → **不是**推定（这一点必须专门有用例，它正是 10-10 那次事故的形态）；
   - HEAD 越过最新 P 标签 → 未知；
   - 只有 `T` 前缀标签 → 未知；
   - 无标签 → 未知；
   - 有清单条目且 commit 一致 → 已核准（无论标签如何）。
2. 实现，跑到测试过。
3. 在只读的镜像状态上跑一次，把得到的分布写进 `STATUS.md`。

**验收**：六个判定用例通过；产物生成；分布与实测一致。

**依赖**：S1（健康产物）。

**关口**：G6（"已核准"需要清单）。

**风险与回滚**：把"推定"当成"已核准"使用，就会在错误版本上给出机制性结论。所以 V4 的数据核对模式必须以**这个档位**为输入，而不是以"有没有标签"为输入。

---

## V3 工具结果版本戳

**目标**：每个读代码的工具结果都带上"哪个仓库、哪个版本、工作区干不干净、档位是什么"。

**依据（实测）**
- `search_code`、`read_file_lines`、`git_inspect`、`codegraph_explore` **四个工具的结果里都没有任何版本信息**。
- `server/data/codegraph/snapshot-manifest.json` 记的是 2026-10-12 的那次构建，而当前图谱是 **2026-10-14 12:02** 重建的 → **这份清单已经和实际图谱不同步**。它本来是"运行起点固定"的雏形，但没人维护。

**改动点**
1. `server/src/tools/code_search.ts`
   - 三个导出函数的结果头各加一行版本行，格式统一，例如：
     `【版本】skt-back/skt_cxy @ P1.2.1 (b87627d, 2026-10-13, 工作区干净) | 档位: 推定 | 判定时刻: 2026-10-14 12:30`
   - 命中文件较多时，**每个文件标题行后追加该文件所属仓库的短版本标识**（`@P1.2.1` 或 `@b87627d`）。同名文件在不同版本里行为不同，文件级信息对模型判断有用（`skt_cxy` 与 `skt_dpxt_background` 有 296 个同名文件）。
   - **同步调整字符预算**：现有 `CONTENT_CHAR_BUDGET=12000`、`TOTAL_CHAR_BUDGET=16000`、`PER_FILE_CHAR_BUDGET=3500`、`READ_CHAR_BUDGET=16000`。加版本行后要核对"返回的命中文数没有明显减少"，把结论记进 `STATUS.md`。
2. `server/src/tools/codegraph.ts`：`formatGraphResultToMarkdown` 的输出头加版本行，但**要写清这是构建时刻的快照**，例如：
   `【图谱快照】构建于 2026-10-14 12:02 | 起点 D:\skt_project | 清单哈希 <sourceManifestHash> | 与镜像当前状态一致: 是/否`
   **不能**假装图谱是实时的。
3. **把 `snapshot-manifest.json` 的写入并进 `CodeGraphService.rebuildIndex()`**，不要继续依赖外部脚本（`tests/eval/reports/mirror-reclone-20261010-111550/build-staged-graph.mjs` 那种）。构件应包括：`createdAt`、`logicalRoot`、`physicalBuildRoot`、`sourceManifestHash`、`repositories[].commit`、`excludedPaths`、`graphFiles`、`stats`。图谱查询结果里要能带出 `sourceManifestHash`。
4. **历史文档与只含 README 的仓库的标注**：这是 **G6 清单的产物**。拿到开发给的名单后，由 `path_policy` 统一加标记（例如 `【历史文档，不代表现行实现】`）。**在 G6 之前不要猜**——`orderNew`/`invoiceNew`/`hotelNew`/`entityOld` 哪一个是现行实现，猜错会把正确答案一起否掉。

**步骤**
1. 先写测试：四个工具各自的结果里含版本行（断言格式）；档位字符串取自 `version-trust.json` 而不是硬编码；图谱结果含 `sourceManifestHash`。
2. 改实现。
3. 在隔离实例里查一次真实代码（例如搜一个既出现在 `skt_cxy` 也出现在 `skt_dpxt_background` 的符号），确认每个文件的行都标对了仓库版本。
4. 重建一次图谱（**隔离数据目录，绝不覆盖生产 `server/data/codegraph/`**），确认 `snapshot-manifest.json` 的 `createdAt` 与 `stats.json` 一致——**这正是当前缺的那一环**。
5. 提交。

**验收**：四个工具都有版本行测试；隔离实例里的版本行与 `git` 实际结果一致；重建后两份时间戳一致；"加版本戳前后命中文数对比"记录在案。

**依赖**：S1、S2、V2。

**关口**：G6（历史文档名单与产品映射）；G9（生产生效要重启）。

**风险与回滚**：版本行会挤占字符预算，可能让模型看到的内容变少 → 用第 5 步的对比守住；若明显减少，就收敛到"只在结果头写一次仓库集合"，去掉文件级标注。

---

## V4 运行起点版本固定与数据核对模式

**目标**：一次运行读到的代码，全程是同一个版本；版本未知的服务只做数据核对，不给机制性结论。

**依据**
- 同步**每 10 分钟**跑一次，一次运行最长 15 分钟（还可续查）→ **运行中途换版本是真实可能的**。
- 现在的 `git_inspect` 只支持 `log` / `blame`，**没有**"按时间点取文件"的能力。
- **好消息**：镜像现在是完整克隆，按时间点取历史是可行的。**已实测**：`git log -1 --before="2026-09-01"` 返回 `1781e977`（2026-09-01），`git rev-list --count --before=` 也正常。**如果镜像还是浅克隆，这条路是不可靠的**——所以这一条依赖 T0.3 里"镜像已是完整克隆"的结论。

**改动点**
1. **运行起点固定**：`server/src/agent/service.ts` 在 `run()` 开始时记录一次
   `runPin = { pinnedAt, repos: { "<相对路径>": "<headSha>" } }`（取自 `version-trust.json`），存进会话私有状态。
2. **漂移标注**：每次工具调用前比对当前 HEAD 与 `runPin`；不一致时**在工具结果里显式标注**
   `【版本漂移】本次运行期间 <仓库> 已从 <A> 变为 <B>，以下结果可能来自不同版本。`
   并把该次运行标记 `version_drift=true`（写进逐次记录与 `STATUS.md`）。**不要**悄悄重跑题目，也不要静默忽略。
3. `git_inspect` 新增按时间点取内容的能力：增加一个 action（建议叫 `show`），参数 `ref`（标签名、提交号，或 `before:YYYY-MM-DD`）与 `filePath`，内部映射成 `git show <rev>:<path>` 或先 `git log -1 --before=<date> --format=%H -- <path>` 再 `show`。
   **这是新增能力，不是修 bug**，所以要有明确的使用条件：**只在题目涉及历史事件（问"当时是什么规则"）时才用**，提示词里要写清。
   路径仍然要过 S2 的 `path_policy`，并且仍然只返回**面向内部的证据**。
4. **数据核对模式**：当一次运行涉及的仓库档位是**未知**时
   - 公开答案**只允许出现数据事实**（查到什么写什么，含单号、金额、状态）；
   - **不得**出现确定的机制、原因、规则结论；
   - 结论段措辞统一为："该服务的现行实现未能确认，以下为数据核对结果。"
   - 落地位置：`publication.ts`（结构性拦截，要有测试）+ 提示词（引导）；
   - **必须有测试**：给定"未知档位 + 一条机制性结论"→ 被拦；给定"未知档位 + 一条数据事实"→ 放行。

**步骤**
1. 先写测试（`tests/server/version_pin.test.ts`）：`runPin` 被记录；HEAD 变化时工具结果里有漂移标注且运行的 `version_drift=true`；未知档位下机制性结论被拦、数据事实放行；`git_inspect` 新 action 的"标签存在"与"标签不存在"两条用例。
2. 改实现。
3. 在隔离实例里对 `skt_cxy` 按某个已存在的标签取一个文件，确认内容与 `git show` 一致（可对照 `P1.2.1`）。
4. 报告里**单独一栏**统计"因版本未知而降级"的次数——**不要把它混进"取证不足"**，这两件事的处置方式完全不同。
5. 提交。

**验收**：四项测试通过；真实标签取文件成功；报告模板里有"因版本未知降级"这一栏。

**依赖**：V2、V3、S2；T0.3 关于"镜像已是完整克隆"的结论。

**关口**：G6。

**风险与回滚**：数据核对模式**会降低覆盖率**——这是 D2 明确接受的取舍。若摸底显示未知档位占比过高导致覆盖率跌破下限（初值 70%），处理方式是**去推动 V1 的部署清单**，**不是**放宽这一档。
