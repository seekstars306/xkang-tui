export interface ServerSkillDefinition {
  id: string;
  name: string;
  targetTools: string[];
  title: string;
  description: string;
  guidanceText: string;
  version: string;
  updatedAt: string;
}

// Centralized company skill repository on the server
export const COMPANY_SERVER_SKILLS: ServerSkillDefinition[] = [
  {
    id: 'troubleshooting-chain',
    name: 'troubleshooting-chain',
    targetTools: ['search_code', 'read_file_lines', 'codegraph_explore', 'git_inspect', 'company_db_query', 'query_company_database', 'search_logs', 'list_log_apps'],
    title: '企业排障方法论（真实证据闭环与高效探索指南）',
    description: '指导模型在遇到疑难故障或状态疑义时，如何自适应探索数据表、向前溯源日志并锁定代码根因',
    version: '2.1.0',
    updatedAt: '2026-08-25',
    guidanceText: `【企业排障与证据闭环参考指南】

一、 自适应数据探索
- 遇到具体单号、流水号、手机号或错误关键词时，直接使用 \`company_db_query\` 查询业务表或支付流水表。
- 若表名未知，可使用 search_schema 发现相关表；避免在未命中的单张表前过早断言“无数据”。

二、 时序溯源与多维交叉验证
- 当单据状态为“已取消”或“已关闭”时，需向前关注创建至取消期间的状态变化与接口返回。
- 结合微服务运行日志（\`search_logs\`）排查接口超时、500 异常堆栈或下游响应报文。

三、 规则穿透与代码印证
- 当捕获到错误提示或金额计算疑义时，利用 \`search_code\` 搜索对应错误码或核心计算方法，结合数据库真实字段与代码规则给出客观解释。

四、 事实第一原则
- 回答中的所有关键数据（单号、金额、状态、错误信息）必须与查询到的真实记录一致。
- 查不到数据时如实反馈，绝不捏造虚假记录。`,
  },
  {
    id: 'company-db-query',
    name: 'company-db-query',
    targetTools: ['company_db_query', 'query_company_database'],
    title: '公司内部只读数据库检索规范与业务地图',
    description: '指导 Agent 在快通道直查或全链路核对时使用 7 大核心业务数据库，保证只读安全',
    version: '1.3.0',
    updatedAt: '2026-08-17',
    guidanceText: `【内部数据库检索规范 - 快速直查与安全守则】
- 目标明确时（已有表名/单号），直接使用 query 执行 SELECT；需要确认表结构时使用 describe_table。
- 业务库职责速查：
  - payment: 支付交易流水 (payment_flow)、商户与渠道配置 (merchant_config)、退款记录 (payment_refund)。
  - skt: 核心主业务大库 (涵盖酒店订单 skt_hotel_order / skt_hotel_order_detail / skt_hotel_order_business、退款工单 order_refund、火车票退款等)。
  - skt_project_hotel: 酒店专属独立业务库。
  - myibe: 航司运价与 IBE 核心数据。
  - transfer: 中转与资金结算服务库。
  - nacos: 微服务配置中心。
- 安全守则：工具在底层具备物理/逻辑只读保护，已拦截所有写操作及分号多语句。对长文本与敏感证书已自动做脱敏截断。`,
  },
];

export function getCompanyServerSkills(): ServerSkillDefinition[] {
  return COMPANY_SERVER_SKILLS;
}
