# 本地评测与诊断工具

本目录中已跟踪的运行器是工程资产；实验答案和业务轨迹写入本地 `eval_run/`，该目录不入库。不要使用 `git add .` 将真实客服材料和一次性脚本一起提交。

## 当前版本检查点

行为、开关、验证记录和已知限制见 [检查点说明](../../docs/checkpoint-20261030.md)。

- `publication_path_probe.mjs`：纯离线的发布路径诊断；只使用假模型与假失败工具。
- `dsh_business_tools.ts`：历史对照用的只读业务工具桥；需要本机 8600 服务和本地凭据。显式运行会查真实业务数据并写本地审计，不在本轮快照验证中调用。

以下命令仅作运行说明，涉及真实模型/真实查询时应先确认预算与范围：

```powershell
node --import tsx scripts/replay_ticket.ts <label> deepseek <port> session:<sessionId> --dry
node --import tsx scripts/eval/dsh_business_tools.ts list
node --import tsx scripts/eval/dsh_business_tools.ts call <toolName> <base64Json>
node --import tsx scripts/eval/publication_path_probe.mjs
```

不得将仅“正常结束”、数字覆盖或自动化测试通过解释成成因正确。脱离同批次、相同输入/配置/模型来源/权限/业务数据时点的评分不可直接作因果比较。

## 旧标准离线评分

[旧标准评分模块](<scripts/eval/old_standard_scoring.ts>)只做内存中的构包和完整性校验，不调用模型、不读取业务库，也不修改历史评分。`prepareOldPack`接收已冻结的公开来源、条件和题号；`validateOldScores`重新核对来源哈希、精确文本、条件×题目完整覆盖、两名不同评分者、逐字引文和来源决定的无答规则，全部通过后才返回未舍入的旧标准宏平均。缺少Sonnet实际产物时必须报错，不能生成0分占位。

这是旧标准评分工具，不替代[严格证据评分校验](<scripts/eval/validate_blind_scores.ts>)。实际业务真伪仍需依据参考和人工核实；机械校验不代表根因正确。

## 8例受控运行器

- [运行器](<scripts/eval/controlled_pair.ts>)：支持独立 baseline/candidate 工作树、空会话、输入/构建/图谱哈希；失败和中止保留，不自动续查或挑优重跑。`--dry` 不发模型请求。
- [代理](<scripts/eval/controlled_model_proxy.ts>)：统一请求参数、global2/per-run1并发，记录HTTP及SSE终止/usage；**相同模型别名不保证上游provider固定**，必须先验证专用Key的provider限制，不能仅凭health就宣称同源。
- [产物校验](<scripts/eval/verify_pair_artifacts.ts>)：原输入、DB公开正文、export与SSE一致性；校验通过不表示业务答案正确。
- [匿名包](<scripts/eval/build_pair_blind.ts>)、[逐行证据副本](<scripts/eval/blind_evidence_text.ts>)、[评分校验](<scripts/eval/validate_blind_scores.ts>)：不向被测模型传参考，评分只按实际已交付内容；不同批次用不同bucket，不覆盖原产物。
- [计量](<scripts/eval/paired_metrics.ts>)、[请求控制审计](<scripts/eval/request_control_audit.ts>)、[证据可比性](<scripts/eval/compare_pair_evidence.ts>)、[报告](<scripts/eval/paired_report.ts>)：区分正常结束、业务交付和infra终止；usage未报告不当0成本。

`after_pair.ts` 只协调已审核来源的批次，不替代来源校验；当前不应以未受限的短别名直接重跑。实验限制与上线决定见 [结果说明](<docs/flow-v1-results.md>)。

```powershell
$env:EVAL_CODEGRAPH_DIR = '<冻结图谱绝对路径>'
$env:EVAL_MODEL_PROXY_BASE = 'http://127.0.0.1:<受限评测代理端口>'
node --import tsx scripts/eval/controlled_pair.ts --dry --repeats=1 --candidate=<独立候选目录>
```
