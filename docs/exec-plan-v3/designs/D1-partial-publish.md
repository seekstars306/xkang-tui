# D1 · 部分发布设计（R1）— 待 G5 批准

> 2026-10-15 起草。本文件只做设计，批准后才进入实现；**实现中的一个前提条件：M3 复核档位实验完成前，不得修改 `review.ts` 的提示词**（否则无法区分"改档位"与"改提示词"的效果）。

## 1. 目标与边界

把"要么全发、要么整体降级"改成**按断言粒度发布**：每条断言标 `confirmed` 或 `pending`；`confirmed` 必须带适用条件与证据引用；`pending` 连同"已查到的事实"一起展示，措辞固定为待核实。

**红线（不因覆盖率让步）**
- 反证阶段（challenge）点名的问题**一律进"待核实"**，不得因"总体通过"放行；
- 部分发布不降低严重误导门槛（D5：严重误导率必须为 0）；
- `PRIVATE_PATTERNS` 与公开过滤逻辑不动。

## 2. 数据结构

`packages/agent-core/src/public.ts` 的 `PublicAnswer` 新增**可选**字段（旧字段一律保留，客户端兼容）：

```ts
claims?: Array<{
  text: string;                    // 断言原文（一句话一个含义）
  status: 'confirmed' | 'pending';
  conditions?: string[];           // 适用条件（来源分支、范围、时间窗）
  exceptions?: string[];           // 已知例外
  evidenceRefs?: string[];         // 证据编号（evidenceIds），confirmed 必须有
}>;
```

对应地，`businessData` / `evidenceSummary` / `conclusion` 等旧字段保持现状；前端未升级时只看到旧字段（降级兼容），升级后可按 `claims` 逐条渲染。

## 3. 服务端拼装位置（关键约束）

`service.ts` 现状是 `parsePublicDraft(...)` 严格校验后 `answer = { ...validated, reviewStatus, traceId }`。`draftSchema` 是 `.strict()`，**任何在 `parsePublicDraft` 之前多出的字段都会被拒**，且该异常会被静默 catch 吞掉。因此：

- `claims` **不进** `draftSchema`（复核模型的输出结构也不塞 claims，避免提示词大改）；
- `claims` 由服务端在 `parsePublicDraft` **之后**拼装：从复核报告（`record.report`）的逐块裁决生成——每个 `block` 的 `assessment === 'supported'` 且 `kind` 为事实类 → `confirmed`（带 `references` 的 `evidenceId` 作为 `evidenceRefs`，`paragraphId` 对应上下文作 `conditions` 来源）；challenge 点名或未 supported 的块 → `pending`；
- `reviewStatus` 语义：全部 confirmed → `reviewed`；有 pending 但至少一条 confirmed → `reviewed`（部分发布）；一条都没有 → `needs_human`。

## 4. 复核侧改动（依赖 M3 之后）

- 引文阶段裁决从"整条 `businessData` 一刀切"改为**每条断言一条裁决**（复核输出结构随之调整 → 提示词要改 → **必须等 M3 完成后**）；
- 部分保留的触发条件从"仅引文阶段失败"扩展到"任一阶段部分未过"，但 challenge 点名仍一律 pending（红线）。

## 5. 开关与回滚

- 用 R5 已落地的 `features.partialPublish` 控制（默认 false）：关闭时完全走现有"全发或降级"路径，行为与基线一致；
- 回滚 = 关开关，无需回退代码。

## 6. 待拍板项

1. `claims` 由服务端从复核报告生成（本设计），还是让复核模型直接输出（需要提示词改动、推到 M3 之后）？
2. 前端渲染 `claims` 的优先级：与现有 `businessData` 并存，还是逐步替代？
