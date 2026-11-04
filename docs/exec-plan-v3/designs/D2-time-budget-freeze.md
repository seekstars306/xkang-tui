# D2 · 15 分钟预算、冻结与续查设计（R2）— 待 G5 批准

> 2026-10-15 起草。决策 D1：单题活跃 15 分钟封顶；到点在安全点冻结并保留已核实内容；人工**不限次数**追加 5 分钟。

## 1. 预算模型

`core.run()` 接受可选 `budget`（**所有新参数必须有默认值**，本地 `--local` 模式行为完全不变）：

```ts
budget: { activeMs, extensions, turnsPerExtension, reviewsPerExtension }
默认: { activeMs: 15*60*1000, extensions: 0, turnsPerExtension: 10, reviewsPerExtension: 1 }
```

- `turnsAllowed = 50 + turnsPerExtension * extensions`，**硬上限 200**；
- `reviewAttemptsAllowed = 2 + reviewsPerExtension * extensions`，**硬上限 10**；
- 硬上限防止自动续查或误操作把费用打飞；
- **被截止时间取消的复核不消耗复核配额**，记为 `aborted_by_deadline`，在下一条 review 状态里体现；
- 追加 5 分钟 = `extensions += 1` 且 `activeMs` 重置为 5 分钟窗口；不限次数，但每次必须由人明确触发。

轮数/协议错/空回复/复核次数/动作重试/补查配额收进 `RunState` 对象（`run()` 内或挂到返回句柄），按 `budget` 计算上限。

## 2. 冻结与持久化

- **只在两次模型/工具调用之间（安全点）冻结**；冻结时把已核实内容持久化（现有 `checkpoint` 机制）；
- `store.ts`：`agent_sessions` 加列（照 `db.ts` 的 `PRAGMA table_info` 先例，不引入迁移框架）：
  - `run_state TEXT`（JSON：`{ extensions, turnsAllowed, reviewAttemptsAllowed, frozenAt, spentTurns, spentReviews }`）；
  - `frozen_answer TEXT`（冻结时已核实内容的公开答案快照）；
- `service.get()` **现有逻辑会把"非 idle 且无活动运行"的会话重置为 idle 并编造 `unavailableAnswer`——这会擦掉冻结状态，必须改**：改为"非 idle 且无活动运行"时读 `run_state`，处于冻结则返回冻结态（含 `frozenAnswer`），不擦除。

## 3. 接口

- `POST /agent/sessions/:id/continue`（需员工鉴权）：`extensions += 1`、重置 5 分钟窗口、恢复运行；重复提交幂等；
- **线缆 `status` 不得新增取值**：已核实客户端 `bclient.ts` 遇到未知 status 会抛且 `list()` 无逐项容错（一个"冻结"会话会让 `/api/sessions` 返回 503）。冻结/可续查信息放进**可选字段**（如 `frozen?: boolean; extensionsLeft?: number`），`status` 仍只有 `idle`/`running`/`waiting_question`；
- 能力协商用 `GET /config/client` 的 `businessApiVersion`（**保持 1 不变**，`business_fixture.ts` 与 `real_systems.it.test.ts` 钉住了它；若改语义必须同步改这两处测试）。

## 4. 取消

运行级取消用 S4 已落地的 `runSignal` + `AgentService.abort(owner, id)`（`BusinessModel` 第 5 参已接通）。**不得**改用 `options.signal`（其语义是"这是一次复核调用"，测试替身靠它分流）。

## 5. 开关与测试

- `features.timeBudget`（R5 已落地，默认 false）：关闭时 `run()` 不收预算，行为与基线一致；
- 测试（`tests/server/time_budget.test.ts`，mock timers）：15 分钟到点冻结且已核实内容仍在；追加一次配额按公式增加、追加 20 次仍被硬上限挡住；被截止取消的复核不消耗配额；冻结后 `service.get()` 不擦状态；序列化后 `status` 仍只有三个取值；
- 回归重点：`tests/client/**` 与本地 harness（`AgentCore` 共用，本轮最易伤到的地方）。

## 6. 待拍板项

1. 冻结时"已核实内容"的呈现：直接展示 `frozenAnswer`，还是提示"已达时长上限，可追加 5 分钟继续"？
2. 续查是否限制同一会话的追加总次数（本设计：不限次数，仅受 200/10 硬上限约束）？
