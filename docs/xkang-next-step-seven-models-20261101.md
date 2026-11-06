# xkang下一步修改方案：七模型征集与评估

## 结论

**七个模型全部回复，没有排除任何一个。** 每个模型都收到同一份当前xkang代码选摘与匿名失败包，并在一次请求中完整写齐诊断、最小修改、阶段推进、验收、上线/回滚及风险。没有续写、重抽优稿或超时截断；网络空闲诊断机制存在，但本次未触发。

**主评和两份匿名独立上下文评审均推荐Astra作为下一步设计蓝本，而非直接照搬上线。** 最有价值的切口是原问题义务台账：覆盖用户问的事项，而不仅仅检查答案已经写出的句子；将已解决、合理待确认、漏答分开，避免全部pending伪装完整。

## 模型与完整回复

| 模型及线路 | 完整回复耗时（不含排队） | 主评/100 | 盲评1 | 盲评2 | 建议 |
|---|---:|---:|---:|---:|---|
| **Astra／当前助手同源agentrouter** | **3.08分钟** | **92** | **80** | **86** | **首选设计蓝本，先shadow** |
| Sonnet 5.5／linke2 | 2.05分钟 | 72 | 65 | 65 | 首步工程接线可借鉴，拒绝其放宽gate后续 |
| Kimi K3.1 Pro／原agent2api | 7.75分钟 | 72 | 52 | 56 | 诊断有价值，计分与接线需重做 |
| Argon／cpa | 5.55分钟 | 71 | 59 | 72 | 借鉴漏问与句子反证解耦；高危词法需收窄 |
| DeepSeek V4.1 Flash／原agent2api | 2.46分钟 | 68 | 60 | 60 | 覆盖契约方向可用，故障发布安全不足 |
| GLM 5.3 Flash／原agent2api | 5.48分钟 | 64 | 49 | 61 | 轻量原型，但默认模式路径与验收误读较多 |
| Gemini 3.8 Flash／cpa | 4.00分钟 | 38 | 32 | 39 | 不建议按原稿实施，关键校验有实质错误 |

分数是**方案可验证水平的主观结构化评价，不是实施后的准确率，也不是模型能力总榜**。按预注册六维权重：诊断25、工程契约20、完整与正确同时改善20、可执行验收15、上线回滚10、不确定性与测量10。主评逐方案对照源码，两名独立上下文代理只看随机P1..P7方案、共同材料及允许代码，不看来源和先前编程排名；它们是上下文独立，不代表不同底层权重评审。

主评与盲评有差异，尤其Kimi、Argon、GLM；原分全部保留，不挑最高、不平均制造精确排名。中间主评算术及已存在regex的纠偏也有记录。共同结论仅是Astra相对更完整、边界清醒，其他模型中间顺序不稳定。当前助手也来自agentrouter线路，可能存在来源先验；因此保留匿名复核和具体代码反证，不把同源认定成能力证明。

Astra实际请求名为agentrouter/gpt-6-astra，经当前助手的Magpie网关，返回gpt-6-astra；不是cpa Astra。Argon请求gemini-4-argon-high，返回gemini-4-argon-e。Gemini请求gemini-3.8-flash-high，返回gemini-3.8-flash-n。模型别名、owned_by和返回标签不认证固定provider或隐藏权重。完整传输记录和七份原文见[响应完整性](<eval_run/proposals-20261101/RESULTS.json>)。

## 哪些建议有效，哪些不能照搬

### Astra：最清楚地区分覆盖、事实与交付

[原方案](<eval_run/proposals-20261101/runs/astra/proposal.md#L29-L85>)提出真实用户来源坐标、来源哈希与稳定义务表，续查不抹原问；引用阶段只接中性义务，不接反证判断；按最终实际保留的答复单元重算覆盖。缺项说明不把无据责任/退款承诺原句搬到pending，未审稿不冒称confirmed。

不足仍存在：来源位置合法不证明子问语义全覆盖，跨持久历史/多模态来源定位和统一decision后处理未完全落实现；partial=false早退已有兜底时，需明确怎样先验证并保留有效内容。**推荐细化+shadow，不称原稿已可上线。**

### Argon：漏问不要挂到答对的句子上

[原方案](<eval_run/proposals-20261101/runs/argon/proposal.md#L39-L128>)把unansweredQuestions与已有blockId异议分开，避免漏答B导致答对A被challenged裁掉；也识别服务三模式都有review回调、core后置护栏不走。字段挽救后再原strict/private校验也有价值。

但首个最小改动捆绑覆盖、时序与高危正则过宽。其伪代码拒绝任何安排修复，不看有效排期依据；词锚定只说明字样出现，不证明授权/对象/规则适用。现有regex已经拦plain“已安排修复”，插入本周/近期等变体才是另一个边界，不能把已存在机制说成缺失。

### Sonnet／DeepSeek：补覆盖有价值，不能拿格式通过当事实已证

Sonnet准确提醒strict内部信封新增字段必须同步schema，[首步接线](<eval_run/proposals-20261101/runs/sonnet/proposal.md#L50-L89>)值得借鉴；但其[后续C2](<eval_run/proposals-20261101/runs/sonnet/proposal.md#L99-L102>)建议gate在复核不可用时发布最后格式/隐私合规稿。DeepSeek也有[类似OR条件](<eval_run/proposals-20261101/runs/deepseek/proposal.md#L65-L67>)。

**拒绝这两项：格式/隐私合法不能证明内容真实，needs_human标签不能消除未证资金或责任承诺。** 只可保留此前真已验证、条件完整且未被新证据推翻的内容。模型自报义务加号码substring也不能检测无号码的整项漏答。

### Kimi：不能让负数分把已证稿输给空稿

其账本方向、时序/请求阶段理解有价值，但核心映射是注释、输入类型适配不足；[coverageScore](<eval_run/proposals-20261101/runs/kimi/proposal.md#L172-L203>)将句数和缺问任意相加减可能为负。当前core空decision评分0，[择优](<packages/agent-core/src/core.ts#L264-L275>)会因此选择空默认，反向吞掉已证内容。应先比较非空安全可发布，再按distinct resolved义务字典序，不用负数混合分。

### GLM：很轻，但测试依赖了服务端走不到的分支

[首步](<eval_run/proposals-20261101/runs/glm/proposal.md#L17-L37>)仅让模型自报unanswered、原文substring过滤；空数组仍能放过漏问。当前original是role/content对象数组，不是string[]，需内容及来源适配。其[验收D6/D7](<eval_run/proposals-20261101/runs/glm/proposal.md#L54-L56>)期待core后置完整性/全失败提醒，实际[三模式review接线](<server/src/agent/service.ts#L204-L225>)使该分支不下穿。partial=false早退也没有解决。

### Gemini：存在可复现的核心错误，不宜优先实施

[时序方案](<eval_run/proposals-20261101/runs/gemini/proposal.md#L195-L204>)把observedAt可当业务时间；实际上它是工具取证时间，会误拒历史正确原因。

[清洗器](<eval_run/proposals-20261101/runs/gemini/proposal.md#L85-L173>)仅替换话术substring，留下“我们保证为您…”其它部分、又加入无证据“专人核实”；风险结论没扫。order_id改成order id仍非中文标签，最终未再parsePublicDraft、旧claims/reviewStatus可能挂回。其“100%稳定交付/绝对安全”没有依据。[合成反例核验](<eval_run/proposals-20261101/assumption-checks.json>)确认这些局部问题，未执行模型给的完整代码，更不声称实际业务效果已测。

## 我建议的下一步

**P0：先记录真实运行Profile和发布损耗，不改变答案。** 每轮start/continue记录实际模式、flags、产物/提示hash、模型返回标签与预算，不存密钥/客户原文。区分未查明、查明后丢失、复核故障；避免按.env或注释猜配置。

**P1：义务台账shadow。** 以Astra为主，原问与明确补充稳定来源定位；复用现有review调用，附加协议独立解析，坏元数据只记coverage_unknown，原内容复核正常继续。公开DTO不变、accepted/publish不变。先与人工预注册义务清单测召回及错拆率，特别无号码多子问。

**P2：只补明确漏问，不把pending算已解决。** 内容裁决后，按实际保留答复映射resolved/partial/needs_input/unresolved；漏问与现成句子反证解耦。有限补查后只说明未知事项，保留独立已证部分；不全兜底、不拼接失去条件的句子、不放末稿未审承诺。

**P3：证据范围/时序，再单独改。** 区分源行limit、单元格裁剪、工具返回裁剪与模型投影裁剪；现有database已有complete/truncated，不重建。current完整0行仍不证明历史不存在；只比较语义已知同实体同请求的业务事件时间，不用observedAt。

**P4：统一公开投影安全。** 删句/降级/data-only后同步核对正文、pending、claims、reviewStatus及引用；高危否定/纯建议/已退款事实防误杀。任意未证承诺不能换字段复活。暂不全面开advisory、不切生产模型、不恢复旧candidate。

详细契约、测试矩阵、灰度和回滚见[下一步实施建议](<eval_run/proposals-20261101/NEXT-STEP.md>)。至少覆盖：无ID多子问、状态代答机制、原问+补充、同名多实体、三个层级裁剪、当前0行问历史、早错晚因、请求无回执、全部相关工具失败、附加元数据坏、review不可用有/无既有已验证稿、partial条件保留、pending/claims风险复活、data-only旧claims、退款正例/建议/否定承诺。

上线前分开有效交付、resolved覆盖、合理待确认、错误因果/实体/承诺、隐私及耗时；固定同证据同候选的发布重放，再同Profile配对模型重跑，两者不混。四个旧参考先确认，不造金标准；无新增严重错误/隐私且交付与resolved覆盖不倒退、有证据改善才灰度。不存在方案写得好就保证正确率提升的结论。

## 原始文件与决定

- [七模型全部原始方案与完整回复记录](<eval_run/proposals-20261101/RESULTS.json>)
- [主评、两份匿名评审与具体原文反证](<eval_run/proposals-20261101/EVALUATION.json>)
- [预注册评分标准](<eval_run/proposals-20261101/RUBRIC.md>)、[评分纠偏记录](<eval_run/proposals-20261101/rating-adjustments.json>)
- [推荐分阶段计划](<eval_run/proposals-20261101/NEXT-STEP.md>)

**本次只评审方案，生产代码、线上模型、飞书和业务数据未修改。** 七个响应请求均成功完整结束、一次提交，Astra准确线路经用户澄清后才加入；没有用cpa Astra替代，没有将久等模型排除。方案评审原文和分歧全保留。
