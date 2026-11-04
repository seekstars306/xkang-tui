# 分阶段义务台账实施、验证与回退（2026-11-01）

## 当前决定

**已按约定撤回全部运行代码到开始时的版本a905e741a326213232dc504086df82d27444304b。** 回退提交98be78f，保存标签xkang-before-obligations-20261101；源码哈希逐项复核一致，新增运行模块与实验测试已移除。生产8600进程PID52236没有重启，线上模型、server/.env和飞书配置未修改。原有未跟踪PDF与评测脚本未删改。

本轮没有完成改善正确率/完整率的上线目标。P1未通过预先门禁，故P2补查/控制及后续证据边界改造未实施；没有以单测绿、添加pending或减少事实作为改善依据。候选保存在分支experiment/obligations-shadow-20261101与提交8ea9c01，便于下次独立修订，不是生产保留版本。

## 分阶段经过

| 阶段 | 实现 | 验证 | 决定 |
|---|---|---|---|
| 回退点 | 固定a905e74、标签及原源码哈希 | 基线相关40/40通过 | 保存 |
| P0 | 安全运行Profile、候选/裁决/公开稿哈希与单元差观测 | 新增5测试+旧回归；阶段相关45/45；修正guide动态读取边界 | 曾独立提交f0f5ac2/9053de2，最终一并撤回 |
| P1 | 来源跨度/哈希、有限intent、影子challenge/citations元数据 | 义务契约46测试、影子接线5测试、旧golden；全量678/678通过；24场景真实模型固定候选对照 | 不达门禁，保存候选后回退 |
| P2及以后 | 漏問補查、安全发布、证据时序收紧 | 没有执行 | 前置门禁失败，停止推进 |

P0观测只记录白名单配置、hash/count，不记录客户原文或Key，异常不阻塞答案。最初把guide捕获为turn固定值改变了动态读取语义，独立复核发现后恢复原来的每次buildPrompt读取，保留启动观察边界；单元差使用去重文本计数，不等于精确语义损耗。即使P0无明显效果退化，按用户要求当前运行代码最终全部回到原回退点。

## P1真实模型对照

独立作者在看新实现之前写定24个合成场景、49个原问义务。工具结果、时间、手机号均合成，不查询实际业务；人工answerA为局部/负例，answerB为完整或诚实未知参照。本轮实际回放固定answerA，使用当前真实reviewAnswer控制路径，Sonnet5.5/linke2做off/shadow两阶段复核，先后顺序交替、2例并行；不向模型发送人工义务答案、semanticFacts或期望resolved清单。

这里off是ANSWER_OBLIGATIONS_MODE关闭/显式obligationShadow=false，不是关闭内容复核REVIEW_MODE=off。仍执行原反证/引文流程。两臂均partialPublish=true，单次复核整体600秒，所有调用未超时，实际合计46+46=92次请求。

| 诊断 | 结果 | 解释 |
|---|---:|---|
| 完成固定候选对照 | 24/24 | 全部原输出保存 |
| 人工原问义务 | 49 | 不把pending当resolved |
| 有效来源抽取场景 | 21/24 | 其他3例未到抽取阶段，不等于纯抽取器失败 |
| 抽取条目数 | 48 | 包含多抽/少抽，条目数不能证明完整 |
| 一对一原文+intent诊断匹配 | 37/49，75.51% | 保守字面诊断，不是语义召回/业务正确率，不能据此裁定语义召回是否达到90%；多实体绑定的确定性缺口另作阻断 |
| 公开五字段+状态发生变化 | 8/24 | 原text含claims差异更多；变化本身不等于退化 |
| accepted | off1/24、shadow1/24 | H03/H13互换，不能当正确率或改善 |
| 复核耗时中位 | off9.05秒、shadow12.18秒 | 同路线小样本，约增加34.5%，不证明总体性能 |
| 调用数 | off46、shadow46 | 不是增加额外独立模型调用，但附加材料改变请求 |

原进度脚本的many-to-one substring曾让同一global status匹配两个实体，H03误报recall=1；最终改为一对一匹配，原进度保留，不覆盖。H04同类计数也修正。对选摘或同義表述，字面匹配可能漏算，因此不能直接宣称实际语义召回75.51%；但它也不能用来证明达标，确定的预算/身份结构阻断足以停止。

固定候选回放测试review/发布环节，不是完整调查Service的真实客户业务效果，不声称已测resolved改善、错误因果下降或隐私发生率。不把accepted数量当正确率，也不把所有changed稿当错误。

## 已确定并复现的三个阻断

1. **影子与原证据共用预算，能直接吞稿。** 相同合成稿与确定性mock，预算992：off accepted=true、2次mock调用、结论“该订单已完成。”；shadow挤掉e1、0次mock调用、accepted=false，结论变通用兜底。此结果不来自模型随机性。challenge后追加neutral还可令citations材料超预算。违背影子不干扰，是停止P2的独立充分条件。
2. **quote唯一性扫描被排除的群历史。** 原问在历史段重复，虽然allowedSpans只允许原问、fingerprint排历史，capture仍全文查重而整批unknown。需要在允许范围查唯一性或验证显式坐标，不能由历史重复改变原问抽取。
3. **同一句同intent不同实体无法独立建账。** 当前stableId/duplicate仅片段与intent，两个订单分别问status、共用整句来源时duplicate_fragment，无法可靠一对一绑定；必须引入有来源依据的实体/时间绑定或可验证更窄跨度，不允许一条global status冒充两个已解决事项。

另有非达标口径：coverage只接受可信verifiedRelations，capture不把模型matched自报当关系验证，因此resolved/reportResolved可保守为0。这个做法避免假“已解决”，但意味着此版validated counts根本不能直接作为90%覆盖门禁。

## 证据与回退复验

- [预先验收和回退约定](<eval_run/staged-20261101/PREREGISTER.md>)
- [基线版本、哈希及测试记录](<eval_run/staged-20261101/baseline.json>)
- [独立24例与人工口径](<eval_run/staged-20261101/HOLDOUT.md>)
- [真实模型对照最终分析](<eval_run/staged-20261101/shadow-analysis.json>)
- [确定性阻断复现](<eval_run/staged-20261101/blocker-reproduction.json>)
- [候选来源快照](<eval_run/staged-20261101/candidate-snapshot.json>)
- [回退后源码逐字校验](<eval_run/staged-20261101/rollback-validation.json>)

回退后全部server/client回归 **622/622通过，0失败**；候选的678包含本次新增56项，撤回后回到622，不能把测试数变化解释为覆盖率收益。[测试记录](<eval_run/staged-20261101/tests-summary.json>)保存阶段与回退结果。

原工程完整server typecheck存在旧feishu探针类型错误，本轮未顺带修改；针对实际生产源码、排除两个既有_probe诊断文件的独立typecheck通过。使用显式TypeScript路径，避免当前node_modules/.bin缺tsc.cmd造成构建脚本失败；这不是模型或业务代码失败。

## 若继续修订，必须先解决什么

下一批先限定到真正不影响原内容路径的观测：附加材料不能挤原证据；超预算回退原请求，不能转为业务稿兜底。再修允许范围唯一性与有来源的实体/时间身份。需要重新冻结独立holdout并一对一验证语义召回、误报、resolved/pending区别，不能重复拿本轮负例当新留出证明。

在这些门禁通过前不接enforce、不部署、不扩大模型重试或预算掩盖问题；不能因为Astra方案评审最好就认为实现一定提升。本次严格执行了效果不足撤回，未将未达标功能留在线上。
