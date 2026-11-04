/**
 * 测试进程的配置默认值。
 *
 * server/src/config.ts 在 import 时就会 dotenv 加载 server/.env，而 .env 是生产配置：
 * 2026-11-04 把生产专用的 REVIEW_MODE=off 写进 .env 后，服务级测试跟着按线上模式跑，
 * 凭空多出 4 个失败（agent_privacy / attachment_evidence / time_budget 等，
 * 答案状态从 reviewed 变成 needs_human）。scripts/start_production.ps1 的注释
 * 早就写明"REVIEW_MODE 放脚本而不是 .env，否则测试会按线上模式跑"。
 *
 * 这里在 .env 之前把测试默认值写进 process.env：dotenv 不覆盖已存在的变量，
 * 于是生产配置怎么改都不再影响测试；需要对照其它模式的用例仍然可以在用例内自行覆盖。
 */
process.env.REVIEW_MODE ||= 'gate';
