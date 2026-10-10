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
    targetTools: ['lookup_order', 'search_code', 'read_file_lines', 'codegraph_explore', 'git_inspect', 'company_db_query', 'search_logs', 'list_log_apps'],
    title: '企业排障方法论（证据闭环）',
    description: '指导模型如何定位单据、核对数据、溯源日志与代码，并在证据不足时如实说明',
    version: '3.0.0',
    updatedAt: '2026-10-07',
    guidanceText: `【企业排障方法论（证据闭环）】

一、先定位单据，再查细节
- 拿到单号/票号/PNR，第一步调用 lookup_order，确定它属于哪条业务线、主表是哪张、关键时间点是什么。不要凭单号长度自己猜表。
- lookup_order 没命中时，不能直接下"订单不存在"的结论，要说明查了哪些表，并向客服确认单号来源。

二、数据核对
- 用 company_db_query 查数据时，先 describe_table 看字段和索引，再用索引列等值查询；单号等长数字按字符串比较。
- 结果里 complete=false 表示数据不完整（超过返回上限或被裁剪），需要名单/统计类结论时必须先 COUNT(*)/GROUP BY 拿到总数并分页取全。

三、日志溯源
- 用数据库里的时间（create_time / order_time 等，已是本地时间）作为 search_logs 的 target_time，keyword 用单号、接口路径或异常类名。
- 最近窗口里"盲查"出来的报错不一定属于本案，只有能和本单的时间、单号、用户对应上的日志才能作为证据。日志 0 条不代表没有发生。

四、代码印证
- search_code 定位到文件后，用 read_file_lines 读完整个方法；找到对某字段的赋值后，继续核对该方法后面是否还有覆盖赋值、条件分支或异常返回。
- 结论里的代码证据要写清文件路径和行号。

五、事实第一
- 回答中的单号、金额、状态、时间、人员必须来自本次会话的工具结果；查不到、查询失败或超时的部分如实说明，绝不补全或编造。`,
  },
  {
    id: 'company-db-query',
    name: 'company-db-query',
    targetTools: ['company_db_query', 'lookup_order'],
    title: '公司内部只读数据库检索规范与已验证的业务表',
    description: '已在历史查询中验证存在的核心业务表与关联方式，以及只读安全守则',
    version: '2.0.0',
    updatedAt: '2026-10-07',
    guidanceText: `【内部数据库检索规范】
- 以下表均在历史查询中验证过存在；其他表请先用 search_schema / describe_table 确认，不要凭经验猜表名或字段名。
- 主订单: skt.\`order\`（order_id；order_type 1=机票 2=火车票 3=保险，其余取值以业务表为准）
- 机票: skt.order_air（主键 air_id；order_id 关联主订单；pnr_no、ticket_no）；行程单 skt.air_itinerary
- 酒店: skt.skt_hotel_order（id / order_id）；明细 skt.skt_hotel_order_detail、费用 skt.skt_hotel_order_business、入住人 skt.skt_hotel_user_info、退订 skt.skt_hotel_refund（均按 order_id 关联）
- 火车票: skt.train_order（order_id；order_number 为 12306 订单号）；改签 skt.train_change_info
- 打车: skt.taxi_order_info（id / order_id）；skt.taxi_business_info（order_id）；skt.taxi_receivable（inside_orderid）
- 收支与账单: skt.in_expend_customer（order_id / unique_id）、skt.finance_bill、skt.finance_bill_booker、payment.payment_flow（order_id）
- 发票: skt.invoice_fp、skt.invoice_fp_relation、skt.invoice_fp_upload
- 人员与组织: skt.sys_user_info、skt.sys_organization、skt.sys_organization_configuration、skt.sys_user_organization
- 消息通知: skt.skt_msg_send_contact（关联发送配置）、skt.skt_msg_send_record_sms（短信发送记录）
- 操作日志: skt_log.operation_record（order_id）
- 安全守则：工具只允许只读语句，已拦截写操作与多语句；长文本字段会被截断显示。`,
  },
];

export function getCompanyServerSkills(): ServerSkillDefinition[] {
  return COMPANY_SERVER_SKILLS;
}
