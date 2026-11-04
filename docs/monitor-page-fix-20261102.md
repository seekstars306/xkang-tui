# 飞书监控台 500 错误修复（2026-11-02）

## 故障

`http://localhost:8600/admin/feishu` 直接返回 `{"error":"请求未完成，请稍后重试。"}`，登录页同样打不开。

## 根因

监控台页面与数据库路径都依赖进程启动目录：

- `res.sendFile(..., { root: 'web' })` 按相对路径解析；
- 监控库默认路径按 `process.cwd()` 拼 `server/data`。

当服务从 `server/` 目录启动（`npm run --prefix server start` 或 `Start-Process -WorkingDirectory server`）时，这两个路径都指向 `server/web` 与 `server/server/data`——实际不存在，于是 `sendFile` 抛错，被全局错误处理器兜底成 500 JSON。

这与登录状态无关：未登录访问返回 401/302 是正常行为，但页面文件根本找不到。

## 修复

1. 新增 `server/src/feishu/runtime_paths.ts`，从模块自身位置推导资源路径。源码 `server/src/feishu` 与编译产物 `server/dist/feishu` 深度相同，因此两者解析结果一致，均指向仓库 `web/` 与 `server/data/`。
2. 监控台登录页/首页、分享页、监控库默认路径全部改为使用该绝对路径。
3. 将“启动时标记中断任务”从 `FeishuMonitorDb` 构造函数移到显式方法 `recoverInterruptedTasks()`，只由飞书通道进程在启动时调用。
   - 原因：监控库由服务端(8600)与飞书通道共用。原实现在构造函数里把 `started_at` 早于启动前 3 秒的 `running`/`queued` 任务全部标记为失败，服务端一旦打开该库就会误杀通道正在执行的任务。
   - 旧测试自身也矛盾：一条要求构造时清理，另一条要求构造时不误杀。

## 验证

- 类型检查通过。
- 监控相关测试 30/30 通过，包括：
  - 源码与编译产物路径解析一致；
  - 路径不随启动目录变化；
  - 构造监控库不会把运行中任务标记失败（第二个打开者看到 `running` 保留）；
  - 真实 Express HTTP：登录页、错误密码 401、登录成功、Cookie 认证后的首页/stats/tasks/filters/详情、未登录 401、分享页；在仓库根、`server`、无关临时目录三种启动目录下全部通过。
- 完整回归 626/626 通过（原 625/626，唯一失败为上述有意行为变更，测试已同步更新）。

## 未做 / 限制

- 未做旧路径数据迁移：实际只存在 `server/data/feishu_monitor.db` 一个库，无 `server/server/data` 残留，故无需迁移。
- 未改动排查模型、会话判定、飞书消息处理与答案发布逻辑。
- 既有“Bearer 任意非空字符串即可访问只读监控接口”的问题不属于本次范围，未修改。
- 部署需重启服务与飞书通道；重启会中断进行中的排查，已安排在无在办任务时进行。
