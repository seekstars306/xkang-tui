# 五模型客观编程测试（2026-11-01）

## 结论

**Sonnet 5.5 / linke2 在这组6道明确规范的编程题中，首次代码提交全部通过。** 每题同时核对隐藏正确性/性能测试与接口约束，合计594个固定测试；其他模型已经完整提交的代码也多数正确，不能把未完成响应等同于算法错误。

这与此前业务排障盲评并不矛盾：本次没有查业务、工具选取、身份消歧、历史证据闭合或客服话术；只测试“依据完整题目规范生成可执行函数”。它证明Sonnet在这组题上表现强，不证明更换模型即可解决原业务排障错误，也不能用六题单次运行推断模型总体排行榜。

## 题目和准入

全部题目为本次新编写的JavaScript同步函数 `solve(input)`，不用框架或外部依赖，JSON输入/输出。题面包括边界、复杂度要求和3个公开示例；隐藏测试和参考实现不发给模型。

| 题 | 内容与关键边界 | 隐藏测试 |
|---|---|---:|
| T01 | SSE分块解析、混合CR/LF/CRLF、逐chunk快照、多行data、持久id、EOF不刷新 | 86 |
| T02 | 十进制金额精确逐笔舍入、负半分、超过2^53的大值、特殊账户名 | 86 |
| T03 | 全局事件去重、stale ID消费、同版本后写、null删除、原型键 | 86 |
| T04 | 有限worker依赖调度、整图环检测、批量同时完成、零耗时任务与稳定顺序 | 110 |
| T05 | 满足多类别配额的最短连续窗口、重复计数、无解和空需求、50k性能输入 | 110 |
| T06 | 原始UTF-16坐标批量编辑、重叠/边界插入顺序、代理对切片、50k编辑 | 116 |
| **合计** | 六题分别有手工边界、seeded随机例和2个性能例 | **594** |

[题面与公开示例](<eval_run/programming-20261101/TASKS.md>)、[A组生成器](<eval_run/programming-20261101/group-a.mjs>)、[B组生成器](<eval_run/programming-20261101/group-b.mjs>)可复查。T01末尾CR暂存是本题明确规定，不是声称完全实现WHATWG流时序。参考分别与不同算法结构的小规模oracle交叉核验，性能例使用独立公式/构造预期；实际QuickJS判题器594/594通过后才冻结模型提示和测试。[冻结清单](<eval_run/programming-20261101/frozen.json>)记录所有原始任务、调用器、判题器、依赖锁文件的SHA256。

## 固定测试条件

- 5模型×6题＝30次计划请求，每次首答，**零自动重试、零代码修订、零测试反馈**；保留所有首次响应、推理流、超时和长度截断。
- 所有模型每题题文及公开示例完全相同，已逐题验证prompt hash一致；全局最多2个请求、每模型最多1个。
- 每次完整模型响应时限240秒，配置最大输出16,384 token；不传temperature或其他采样选项，不要求response_format，不注册工具。
- DeepSeek/Kimi/GLM沿用原本机agent2api线路，effort=max；Gemini沿用cpa线路，Sonnet用linke2，effort=high；外部HTTPS经现有Clash7890，证书验证开启。**相同请求限额不代表供应商兑现相同思考预算/真实输出上限**，尤其不同网关的reasoning token计量可能不同。
- 返回模型名：Sonnet为claude-sonnet-5-5、GLM为glm-5.3-flash、Gemini为gemini-3.8-flash-n、Kimi为Kimi-K3.1-Pro；DeepSeek请求别名返回deepseek-v4.1-flash和DeepSeek-Flash两种。返回名不认证固定权重或provider，原线路仍可动态路由。
- 源代码仅去掉完整外层js/javascript围栏及外部空白，不去掉export、不替模型修语法/逻辑，失败不得选取第二次。

## 完整题目通过结果

| 模型/线路 | 全部测试通过题数（固定6题） | 完整代码已提交 | 已提交代码错误 | 240秒未完成响应 | 输出长度耗尽未交代码 | 完整代码响应耗时中位 |
|---|---:|---:|---:|---:|---:|---:|
| **Sonnet 5.5 / linke2** | **6/6** | **6/6** | **0** | **0** | **0** | **6.4秒** |
| Gemini 3.8 Flash High | 5/6 | 5/6 | 0 | 1 | 0 | 148.2秒 |
| GLM 5.3 Flash | 4/6 | 4/6 | 0 | 2 | 0 | 147.1秒 |
| DeepSeek V4.1 Flash | 1/6 | 2/6 | 1 | 3 | 1 | 65.6秒 |
| Kimi K3.1 Pro | 0/6 | 0/6 | 0 | 6 | 0 | 无完整代码样本 |

30次计划请求只有**17份完整代码**：其中16份通过该题全部隐藏例，1份DeepSeek金额题失败。其余12次响应超时、1次输出长度耗尽，不能写成“13份算法全错”。各模型六题固定分母不变，但也报告“已返回代码正确性”：Sonnet6/6、Gemini5/5、GLM4/4、DeepSeek1/2、Kimi没有可判定样本。

| 题 | Sonnet | Gemini | GLM | DeepSeek | Kimi |
|---|---|---|---|---|---|
| T01 分块解析 | 通过 | 响应超时 | 响应超时 | 通过 | 响应超时 |
| T02 精确金额 | 通过 | 通过 | 通过 | 18/86，代码错误 | 响应超时 |
| T03 版本状态 | 通过 | 通过 | 通过 | 响应超时 | 响应超时 |
| T04 依赖调度 | 通过 | 通过 | 通过 | 响应超时 | 响应超时 |
| T05 配额窗口 | 通过 | 通过 | 通过 | 响应超时 | 响应超时 |
| T06 文本编辑 | 通过 | 通过 | 响应超时 | 长度耗尽、没有代码 | 响应超时 |

### 超时和代码错误的区别

全部12次超时都已经收到响应流，且有推理文本但没有最终代码。不是简单“域名连不上”，也不应一概称接口故障；可见模型/网关仍在输出思考或排队，未能在240秒里交出首次代码。Kimi首响应头约62–79秒，随后继续思考；只凭这些结果无法区分权重、路由、队列和推理档位的各自影响。

DeepSeek T06在107.2秒以finish_reason=length结束，报告16,384 completion/reasoning token，content为空；是输出预算耗尽而不是240秒超时。这种模型与Sonnet不可按配置的16,384直接认定拥有相等有效思考预算。

DeepSeek T02的确定错误是用普通对象当账户映射，账户名`__proto__`未被保存，汇总少算该账户；不是笼统的“BigInt精度不够”。一个手工例期望总计2800分，实际2600分，恰好漏了200分；其逐笔舍入对普通账户可工作。[首次实现:4](<eval_run/programming-20261101/responses/T02-deepseek.js#L4>)及[映射写入:54–58](<eval_run/programming-20261101/responses/T02-deepseek.js#L54-L58>)，[失败输入与实际输出](<eval_run/programming-20261101/failure-analysis.json>)保留，无修改代码后重算成绩。

## 安全执行和独立审阅限制

1. 使用QuickJS WebAssembly新runtime/context，guest没有process、require、fetch、console、WebAssembly、setTimeout或任何注册的宿主回调；不安装module loader、不把模型源码交给Node vm或宿主eval。设置guest128MiB内存、1MiB栈、周期interrupt与墙钟截止检查。该WASM自身具有宿主运行支持，**不是零WASM-import或绝对沙箱安全证明**。
2. 原冻结判题器只比较JSON投影，独立复核指出输入可变、非JSON返回类型和共享快照对象可能漏检。因此另存接口约束补查器，对**同一代码、同一594例、所有5模型**验证题面已要求的这些条件；原评分完整保留，补查不增加新题、不给模型反馈。参考594/594通过补查，本次30份评分与原分**无差异**。这是判题完善，不是重定义题目或挑高分。
3. 独立审阅发现HTTP chunk独立toString(utf8)有跨chunk字符损坏风险。首答均已固定，未静默改调用器或源码；实际30个样本中代码/推理U+FFFD扫描均为0，但**不能消除实现风险**。该问题须在未来新批次改用流式解码，不能无条件声称本轮输送绝对无损。
4. T01独立oracle的正则无dotAll，未覆盖合法U+2028/U+2029；现有冻结fixtures不含这些字符，未证明任何实际expected错误。T01极大快照输出、T06未限制全部替换文本大小等合法输入组合也可能超过配置内存；性能结论只覆盖本次冻结输入规模，不外推整个题面上限组合。
5. 时间和内存主要作用于guest，宿主dump/getString/JSON.parse没有独立硬进程时限或总RSS保证。周期interrupt次数不是精确指令fuel。此次未发现沙箱逃逸，亦不作绝对安全保证。
6. 六题每模型一次，不能声明统计显著领先或编程能力总榜。“Sonnet这组六题全部正确且快速”有证据，“Kimi不会编程”“更换Sonnet必然修复业务排障”无证据。

[判题器](<eval_run/programming-20261101/judge.mjs>)、[接口约束补查](<eval_run/programming-20261101/judge-contract.mjs>)、[审閱限制](<eval_run/programming-20261101/review-limits.json>)均保留。

## 产物、复核与决定

- [全部结构化结果](<eval_run/programming-20261101/RESULTS.json>)，[结果摘要](<eval_run/programming-20261101/RESULTS.md>)，[题面](<eval_run/programming-20261101/TASKS.md>)。
- [原判题摘要](<eval_run/programming-20261101/grades-summary.json>)、[接口补查摘要](<eval_run/programming-20261101/grades-contract-summary.json>)、[参考校验](<eval_run/programming-20261101/reference-validation.json>)、[补查参考校验](<eval_run/programming-20261101/contract-reference-validation.json>)。
- [最终完整性](<eval_run/programming-20261101/final-integrity.json>)确认5×6唯一完整、每题五个模型prompt hash相同、冻结文件hash未变和30条补查/原分一致；独立只读复核也复算通过题数与17份完整代码，不涉及新评分或新模型调用。

本轮只在本地ignored评测目录增设依赖、调用及解释器，不改主工程依赖或锁文件、不查业务、不触达飞书、不更改线上模型和运行代码。所有提交/判题任务已完成。**先保留线上旧版，不根据这一编程微基准自动部署模型切换；如继续排障优化，应单独测试模型是否能正确追踪历史证据和选择业务工具。**
