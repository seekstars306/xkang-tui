# 80 · 工单驱动实验流程（v1，2026-10-21 经 T001 实跑验证）

## 背景约束

- 工单**逐条随时到来**，不批量给出；每条算一个样本（带截图也算一条）。
- 工单**只在提出的那一刻可验证**：代码会被修复、数据会被改动，事后无法复现"当时的系统状态"。
- **金标准由用户制定**（细粒度优先，不保证每次都有）。Claude 的核验只是假设，默认不可信，不得自封裁判。
- 在积累到足够数量（暂定 20 条）之前，不做任何"系统变好/变差"的统一判断。

## 流程（每条工单五步，顺序固定）

### 1. 先跑（最优先，秒级启动）
用户发来工单后**立即**跑 xkang，不等任何其他动作：

```powershell
$env:ARM='new'; $env:RUN_LABEL='T00n-xkang'; $env:INPUT_FILE='tests/eval/reports/_retest/tickets/T00n/T00n.json'
$env:SOURCE_SESSION='T00n'; $env:SKIP_ARM_PROOF='1'; $env:RUN_TOKEN_CAP='8000000'
node --import tsx tests/eval/reports/_retest/full_ticket_run.ts
```

- 只跑**一次**（同一随机种子的重复运行已被证明只测方差）。
- 带截图的输入：`{messages:[{role:'user',content:[{type:'text',...},{type:'image_url',image_url:{url:'data:...;base64,...'}}]}]}`。
- 前置检查：8693 端口必须空闲（startIsolatedServer 硬编码端口，残留进程会让运行静默卡死——T001 前踩过）。

### 2. 冻结（跑完马上做，几分钟可接受）
`tickets/T00n/snapshot/`：

| 内容 | 方式 |
|---|---|
| 18 个子仓库 commit + 分支 + dirty 清单 | `repos.json`（D:\skt_project 顶层非 git，子仓库各自是） |
| dirty 仓库的未提交改动 | `patches/*.patch`（git diff --binary）+ untracked 清单 |
| 全量源码副本 | robocopy，排除 node_modules/.git/target/dist/build；实测 ≈0.4GB/单 |
| **prod-config 例外** | 只存 文件名+大小+sha256 清单，**不存内容**（含凭据） |
| codegraph 快照 | 复制 snapshot-manifest.json、version-trust.json |

数据快照（工单涉及的表行、日志原文）**尽量**在同 session 内补采；xkang 的 messages.json 里已有工具结果全文，多数情况这就是当时的数据证据。

### 3. 我的核验（标级别，不当裁判）
写入 `hypothesis-Hn.md`，每条命题标四级：
- **已验证**：可由冻结快照/录制机械复算
- **代码证据**：代码路径明确，但运行时未确认
- **数据关联**：数据吻合、因果未证
- **推测**：只有现象

并写"什么观察会推翻我"（可证伪检查）。

### 4. 金标准到达后判 L2
- **L1 客观层（不依赖金标准，永远先记）**：是否定位模块 / 是否找到错误日志 / 是否到达请求路径 / 是否闭合到根因 / 交付状态 / 成本
- **L2 对照层（依赖金标准）**：逐要素 命中/部分命中/未命中；无金标准则整层 `unjudged`，**不得**在 L1 里写"correct"之类的预断（T001 踩过：ledger 曾误填 delivered_correct，已改 pending_L2 后才回填）

### 5. 落账
- `tickets/T00n/verdict.json`（L1+L2）
- `tests/eval/data/daily-tickets.tsv` 追加一行（含 snapshot_dir、gold_standard_status 列）
- 目录骨架：`ticket.md / input/ / T00n.json / snapshot/ / hypothesis-Hn.md / verdict.json`

## 已知坑（本流程实测踩过）
- PowerShell `-replace`/内联脚本改 UTF-8 文件会写坏编码 → 一律用 node 脚本文件，不用 -e/-replace 内联。
- node 里 Windows 绝对路径 import 要 `file://` URL 或相对路径。
- `node --check` 不能校验 .mjs。
- full_ticket_run 的 ARM 自证与工具探针按 G3④ 两臂写死，单题运行用 `SKIP_ARM_PROOF=1`。
- 提醒文案写死"30 轮"（50×0.6 的比例文案），改额度时必须联动，否则模型收到的提示与实际阈值不符。

## 状态
- 首次完整执行：T001（2026-10-21，用户金标准同日到）——流程可用。
- 目标样本量：20 条后做统一判断；在此之前不改规则、不调参数。
