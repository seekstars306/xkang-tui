# 70 规则层冻结与留出集台账

第 1、3 项的可交付物：把「从单张工单抽出来的规则」钉住，把「判定线」提前登记，让后面每一次调优都能被对照。
本文件进 git；工单原文、单号、客户信息只进 `tests/eval/data/**`（被 `.gitignore` 的 `data/` 规则忽略）。

## 1. 为什么冻结

2026-10-16 那张酒店重复开票工单暴露出一条错误路径：拿单张工单的教训直接往复核和提示词里加词表（先是角色称谓词，
再是成因禁令）。加一条禁令只能让答案更安全、不能让它更对——现网同题重跑的工具调用分布与改动前逐项相同，
做去重判断的那个分支一次都没被读到。所以规则层按「先冻住、等对照数据再决定去留」处理。

## 2. 分类口径

| 类 | 意思 | 处置 |
|---|---|---|
| `ticket_derived` | 从单张工单抽出的词表或内容禁令（角色称谓词、成因禁令等） | **冻结**：逐字保住，解冻要等留出集对照数据 |
| `general_procedure` | 通用工程步骤（找写入方法、读判定分支、数入口次数、按可解码字段还原时间） | 允许新增，但必须登记；判效果看工具调用分布 |
| `delivery_policy` | 交付形态（部分发布的模板、措辞、待核实提示） | 冻结措辞；行为由测试守 |
| `infrastructure` | 代码路径修复（引文逗号归一化、R1 逐句保留） | 不进清单，由行为测试守 |

**解冻条件（写进清单）**：`ticket_derived` 的去留须等留出集对照数据；在此之前只允许新增 `general_procedure`，不允许再新增 `ticket_derived`。

## 3. 冻结清单

清单在 `tests/eval/frozen-rules.json`，当前 12 条、`ticketDerivedCount = 7`：

| id | 类 | 位置 | 守住什么 |
|---|---|---|---|
| `review.actor_role_word_table` | ticket_derived | `server/src/agent/review.ts` | 词表 `开票经办人\|经办人\|操作人\|提交人\|财务` 逐字不变 |
| `review.prompt.cause_assertion` | ticket_derived | 同上 | 复核提示词里的因果/机制类断言纪律 |
| `review.prompt.actor_role` | ticket_derived | 同上 | 动作主体角色称谓的那句 |
| `review.revision_discipline` | ticket_derived | 同上 | 【修订纪律】整段 |
| `review.revision_discipline.no_time_inference` | ticket_derived | 同上 | 不得用时间间隔、记录条数或经办人/创建人字段反推成因 |
| `service.business_prompt.cause_discipline` | ticket_derived | `server/src/agent/service.ts` | 每条断言自成一句完整短句 |
| `investigation.prompt.repeat_branch_rule` | ticket_derived | `server/src/agent/investigation_prompt.ts` | 工作原则 8：重复、并发类怀疑必须读到判定分支 |
| `investigation.prompt.repeat_steps` | general_procedure | 同上 | 重复/并发四步（l2，order 86） |
| `review.directed_followup` | general_procedure | `server/src/agent/review.ts` | 【定向补查】四步，只在成因类断言没过核实时追加 |
| `publication.partial_reply_template` | delivery_policy | `server/src/agent/publication.ts` | 部分发布模板 |
| `publication.partial_reply_suffix` | delivery_policy | 同上 | 部分发布后缀 |
| `publication.partial_reply_wording` | delivery_policy | 同上 | 「其余事项仍在核实中」这类措辞 |

出处（`provenance`）只写「哪张工单/哪次改动、为什么加」，不含编号与个人信息。

2026-10-17 曾按用户批准加第 13 条 `review.cause_unknown_followup`（G3④ 的 C，`general_procedure`）。2026-10-19 用户选择撤回 G3④，这条随代码一起删掉，回到上表 12 条（见 10 号预算单第 7.5 节）。删的是一项撤回的功能，不是解冻 `ticket_derived`。

## 4. 守门断言（`tests/server/rule_freeze.test.ts`）

1. 每条 `anchor` 仍逐字出现在对应源文件里（改写或删除会红，提示语指向 `unfreezeCondition`）；
2. `word_table` 条目按 `名字 = '…'` 提取、按 `|` 切开后与清单逐字相等；
3. 角色名词候选表里出现、但未被登记词表覆盖的词 → 红（防静默新增工单派生词；候选表只会越来越严）;
4. 分类合法、id 唯一、出处齐备、`ticket_derived` 条数与声明的 `ticketDerivedCount` 一致、解冻条件仍写明依赖留出集。

清单里另外记了两条核对结论：客户端孪生文件 `src/harness/system_prompt.ts` 不含规则层文本（无需镜像条目）；
`evidenceContainsQuote` 逗号归一化与 R1 `PARTIAL_REPLY_*` 属 `infrastructure`，由行为测试守，不进清单。

## 5. 留出集：流程与判定线

工具 `scripts/eval/holdout.ts`（`--init / --freeze / --refreeze --reason / --verify / --stats`）：

- 每题一个 JSON，文件名 = `ticket_id`；必填字段 `ticket_id / business_line / question_type / core_demand / event_time /
  snapshot_time / services / answerable / background / attachments / deidentified / question`（`ground_truth`、`code_version` 可选）；
- 冻结 = 固定种子（`20261016`）洗牌 + 逐文件 sha256 + `manifestHash`，判定线随清单一并落盘；
- 冻结后只允许 `--verify`（漂移/新增/缺失）与 `--stats`；追加或修改必须 `--refreeze --reason="…"`（理由 ≥8 字，旧清单留档 `.prev`）；
- 判定线（预登记）：试点 ≥60 个已交付结论、点估计 ≥90%、严重误导 0；上线 150 单（最低 100）、覆盖率下限 ≥70%、
  交付答案正确率单侧 95% CP 下限 ≥90%、严重误导 0、≥95% 在预算内完成。**所有阈值只在留出集上计算。**

## 6. 台账

`scripts/eval/daily_tickets.ts` 逐单落 `tests/eval/data/daily-tickets.tsv`（同样被 git 忽略）：
`ticketId / date / businessLine / questionType / answerable / coreDemand / question / groundTruth / verdict / failureCategory / notes`，
`verdict` 取 `delivered_correct | delivered_partial | unresolved_honest | wrong | severe`。

## 7. 当前状态与阻塞

- 留出集**工单本体为 0**：外部依赖 G7（客服负责人导出 ≥60 条并给出核心诉求）。工具、判定线、洗牌种子已就位，
  工单到位后按 `--refreeze --reason` 分批入集；在此之前不做任何「准确率」宣称。
- 台账已有一条开发集记录（酒店重复开票，标记为开发集/回归用例），只作格式与流程验证，不入统计。
- G3③（规则消融对照）预算单见 `09-g3-budget-rule-ablation.md`，**未经批准不得启动任何付费运行**。

## 8. 局限

- 守门只能证明「已登记的还在」和「没偷偷新增角色词」，不能证明「新增的规则都登记过」——登记动作本身会进 git diff，这是人工兜底。
- `general_procedure` 允许新增，代价是新步骤也可能无效；判定方式是工具调用分布，不是措辞（见 09 号文档的判定线）。
- 历史事件类题目若拿不到事件当时的代码版本，参考答案本身就不牢；这类题只能进留出集做「诚实降级」评分。
