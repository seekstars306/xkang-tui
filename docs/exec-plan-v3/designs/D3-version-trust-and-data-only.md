# D3 · 版本可信度与数据核对模式设计（V2–V4）— 待 G5 批准

> 2026-10-15 起草。决策 D2：部署版本分三档；**未知**版本的服务只做数据核对，不输出确定的机制、原因、规则。

## 1. 三档判定（已落地，见 `server/src/codegraph/version_trust.ts`）

| 档位 | 条件 | 现状（2026-10-15 只读实测） |
|---|---|---|
| 已核准 approved | 部署清单有该仓库条目、`commit === HEAD`、`artifactSha256` 非空 | 0 个（清单待 G6） |
| 推定 presumed | 工作区干净**且** HEAD 恰好等于最新 `P*` 标签（`T1.0.0` 不算） | 7 个 |
| 未知 unknown | 其余全部（脏工作区、HEAD 越过标签、只有 T 标签、无标签） | 10 个 |

- 判定产物 `version-trust.json` 与 `mirror-health.json`、`stats.json` 同目录，由同步流程每次同步后刷新（带 `evaluatedAt`——**"推定"是易变的，任何文档不许写死档位**）；
- 部署清单 schema 与占位样例：`docs/exec-plan-v3/deployment-manifest.example.json`；校验器 `scripts/eval/validate_deployment_manifest.ts`（含 `list_log_apps` 实测 9 个服务的覆盖检查）；真实清单（git 忽略）由 G6 提供。

## 2. 工具结果版本戳（已落地）

- `search_code` / `read_file_lines` / `git_inspect` 结果头带 `【版本】<repo> @ <tag> (<sha>, 工作区干净/有未提交改动) | 档位: <三档> | 判定时刻: …`；多文件命中时文件行带 `@<tag>` 短标识；
- `codegraph_explore` 结果头带 `【图谱快照】构建于 … | 起点 … | 清单哈希 … | 与镜像当前状态一致: 是/否`——**明确是构建时刻的快照，不假装实时**；
- `snapshot-manifest.json` 由 `rebuildIndex()` 同刻落盘（`createdAt` 与 `stats.json` 完全一致），结束"外部脚本维护、清单与图谱不同步"的状态；
- 字符预算已核对：加版本行后命中的文件列表数不变、长文件读取行数不变、内容块 12→11（第 12 个文件转为仅列路径，有明确 offset 提示），无有效内容被静默丢弃。

## 3. 运行起点固定与漂移检测（已落地）

- `beginRunPin()` 在运行起点快照各仓库 HEAD；`checkRepoDrift()` 在工具调用时检测漂移，命中则在结果头部追加 `【版本漂移】本次运行期间 <仓库> 已从 <A> 变为 <B>，以下结果可能来自不同版本。`；
- `git_inspect` 新增 `action: 'show'`（ref 支持标签、提交号、`before:YYYY-MM-DD`；路径同样过 `resolveRepoFile` 的策略与边界校验）。

## 4. 数据核对模式（代码已落地，开关默认关）

`server/src/agent/publication.ts` 的 `applyDataOnlyMode(draft, unknownInvolved)`：

- 当本次证据涉及的仓库存在 **unknown** 档位且开关打开时：
  - 结论段**统一替换**为 `"该服务的现行实现未能确认，以下为数据核对结果。"`；
  - `businessData` / `evidenceSummary` 只保留**数据事实**（过滤机制/原因/规则类表述：因为、原因、机制、规则、必然、分支、根因、一律……）；
  - `customerReply` 含机制表述时清空；
  - `pendingItems` 不过滤（待确认事项本就是诚实形态）；
- 开关：`DATA_ONLY_FOR_UNKNOWN`（默认 `false`）。默认关的原因：该模式**会降低覆盖率**（D2 明确接受的取舍），且生产上还没有 `version-trust.json`（需 G0 重启 + 首次同步后才生成）；建议随 G5 批准与摸底数据一起开启；
- 已承认的取舍：若摸底显示 unknown 占比过高导致覆盖率跌破下限（初值 70%），处理方式是**推动 V1 部署清单**，不是放宽这一档。

## 5. 待拍板项

1. `DATA_ONLY_FOR_UNKNOWN` 是否随 G5 批准一并打开（还是等第一份真实部署清单到位后再开）？
2. unknown 档位的"数据核对"是否也覆盖 `git_inspect show` 的历史版本内容（当前设计：版本戳已带档位，由模型自行谨慎，不做额外拦截）？
