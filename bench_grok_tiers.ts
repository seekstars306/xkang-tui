/**
 * Grok 4.6 四大级别 (low / medium / high / xhigh) 综合能力压测基准套件
 * 包含 20 个独立评测用例 × 4 个模型级别 = 80 次真实调用
 * 维度：
 *   1. 任务编排能力 (Task Orchestration: 依赖链式调用、错误自愈、分支决策、并行汇聚等)
 *   2. 执行精度与约束遵循 (Execution: 严格JSON Schema、SQL构造、批量表格清洗、Diff补丁等)
 *   3. 深度逻辑与智能推理 (Deep Reasoning: 复杂流水对账、分布式链路根因归因、并发死锁分析等)
 */
import OpenAI from 'openai';
import fs from 'node:fs';

const API_KEY = 'g2a_324a41cef63d_bO1cMeFYS7XfSeIm84jBB0-Q6x2iLM04';
const BASE_URL = 'http://34.220.149.219:8000/v1';

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  timeout: 120000,
});

export const TIERS = ['grok-4.6-low', 'grok-4.6-medium', 'grok-4.6-high', 'grok-4.6-xhigh'] as const;
export type Tier = typeof TIERS[number];

export interface TestCase {
  id: string;
  category: 'Orchestration' | 'Execution' | 'Reasoning';
  title: string;
  description: string;
  systemPrompt?: string;
  userPrompt: string;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  mockToolExecutor?: (name: string, args: Record<string, any>, callHistory: any[]) => string;
  validator: (result: {
    finalText: string;
    toolCalls: Array<{ name: string; args: any }>;
    turns: number;
  }) => { pass: boolean; score: number; reason: string };
}

// 模拟排障工具集
const ORCHESTRATION_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'query_order',
      description: '根据订单号查询订单基本信息、支付流水号和当前状态',
      parameters: {
        type: 'object',
        properties: { order_id: { type: 'string', description: '订单号' } },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_payment_gateway',
      description: '根据支付流水号查询网关支付状态及退款申请单号',
      parameters: {
        type: 'object',
        properties: { payment_id: { type: 'string', description: '支付流水号' } },
        required: ['payment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_refund_log',
      description: '根据退款单号查询三方渠道真实退款银行到账日志',
      parameters: {
        type: 'object',
        properties: { refund_id: { type: 'string', description: '退款申请单号' } },
        required: ['refund_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_db_query',
      description: '执行只读 SQL 查询业务数据',
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'SQL 查询语句' } },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_service_config',
      description: '获取指定微服务的线上配置与降级开关',
      parameters: {
        type: 'object',
        properties: { service_name: { type: 'string' }, env: { type: 'string', enum: ['prod', 'test'] } },
        required: ['service_name', 'env'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_paginated_logs',
      description: '分页搜索系统异常错误日志',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          page: { type: 'integer' },
          page_size: { type: 'integer' },
        },
        required: ['keyword', 'page'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_cs_ticket',
      description: '创建客服流转工单',
      parameters: {
        type: 'object',
        properties: {
          ticket_type: { type: 'string', enum: ['URGENT_REFUND', 'TECHNICAL_BUG', 'VIP_COMPENSATION'] },
          order_id: { type: 'string' },
          amount: { type: 'number' },
          audit_details: {
            type: 'object',
            properties: {
              root_cause: { type: 'string' },
              responsible_system: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['root_cause', 'responsible_system'],
          },
        },
        required: ['ticket_type', 'order_id', 'amount', 'audit_details'],
      },
    },
  },
];

export const BENCHMARK_TEST_CASES: TestCase[] = [
  // =========================================================================
  // 维度一：任务编排与多步调度 (Orchestration - 6 Cases)
  // =========================================================================
  {
    id: 'Orch-1',
    category: 'Orchestration',
    title: '三级依赖链式工具调度',
    description: '从订单号 -> 支付网关流水 -> 银行退款日志，必须按依赖次序完成 3 步完整链式调用',
    userPrompt: '用户投诉订单 "ORD_998124" 退款未到账，请使用工具链条排查到底卡在哪一步，并给出最终退款失败原因及到账状态。',
    tools: ORCHESTRATION_TOOLS,
    mockToolExecutor: (name, args) => {
      if (name === 'query_order' && args.order_id === 'ORD_998124') {
        return JSON.stringify({ order_id: 'ORD_998124', status: 'REFUND_SUBMITTED', payment_id: 'PAY_20260822_998', amount: 899.00 });
      }
      if (name === 'query_payment_gateway' && args.payment_id === 'PAY_20260822_998') {
        return JSON.stringify({ payment_id: 'PAY_20260822_998', gateway_status: 'REFUND_IN_PROCESS', refund_id: 'REF_EXT_44120' });
      }
      if (name === 'query_refund_log' && args.refund_id === 'REF_EXT_44120') {
        return JSON.stringify({ refund_id: 'REF_EXT_44120', bank_code: 'ICBC_REJECT', bank_message: '用户银行卡状态异常(已冻结/销户)，资金原路退回失败', timestamp: '2026-08-22 09:12:00' });
      }
      return JSON.stringify({ error: `未找到数据: ${name} ${JSON.stringify(args)}` });
    },
    validator: ({ toolCalls, finalText }) => {
      const calledOrder = toolCalls.some(t => t.name === 'query_order');
      const calledPay = toolCalls.some(t => t.name === 'query_payment_gateway');
      const calledRef = toolCalls.some(t => t.name === 'query_refund_log');
      const mentionsBankError = /冻结|销户|卡状态异常|原路退回失败/i.test(finalText);
      const pass = calledOrder && calledPay && calledRef && mentionsBankError;
      let score = 0;
      if (calledOrder) score += 25;
      if (calledPay) score += 25;
      if (calledRef) score += 25;
      if (mentionsBankError) score += 25;
      return { pass, score, reason: `工具调用数: ${toolCalls.length}, 包含关键原因: ${mentionsBankError}` };
    },
  },
  {
    id: 'Orch-2',
    category: 'Orchestration',
    title: 'SQL语法报错自愈与重试编排',
    description: '首次执行 SQL 遇到字段名不存在报错，模型必须自动分析错误信息、修正 SQL 并二次执行成功',
    userPrompt: '请帮我查询 2026 年 8 月份研发部总报销金额最高的员工姓名。',
    tools: ORCHESTRATION_TOOLS,
    mockToolExecutor: (name, args, history) => {
      if (name === 'execute_db_query') {
        const sql = String(args.sql || '').toLowerCase();
        if (sql.includes('total_amt') || sql.includes('amount_sum') || !sql.includes('reimburse_amount')) {
          return JSON.stringify({
            error: "SQLException: Unknown column 'total_amt' in field list. Available columns: [emp_id, emp_name, dept_name, reimburse_amount, expense_date]",
          });
        }
        return JSON.stringify([
          { emp_name: '赵六', dept_name: '研发部', total_reimburse: 18500.00 },
          { emp_name: '张三', dept_name: '研发部', total_reimburse: 12000.00 },
        ]);
      }
      return JSON.stringify({ error: 'unknown tool' });
    },
    validator: ({ toolCalls, finalText }) => {
      const sqlCalls = toolCalls.filter(t => t.name === 'execute_db_query');
      const gotZhaoLiu = finalText.includes('赵六') || finalText.includes('18500');
      const recovered = sqlCalls.length >= 2;
      const pass = gotZhaoLiu && (sqlCalls.length >= 1);
      const score = gotZhaoLiu ? (recovered ? 100 : 90) : 0;
      return { pass, score, reason: `SQL调用次数: ${sqlCalls.length}, 正确识别赵六: ${gotZhaoLiu}` };
    },
  },
  {
    id: 'Orch-3',
    category: 'Orchestration',
    title: '根据中间态动态分支调度',
    description: '先查配置，若为 prod 则必须调取降级日志；若为 test 则直接输出',
    userPrompt: '请检查 "hotel-order-service" 在 "prod" 环境下的配置，并根据其降级状态排查该服务是否有熔断风险。',
    tools: ORCHESTRATION_TOOLS,
    mockToolExecutor: (name, args) => {
      if (name === 'get_service_config') {
        return JSON.stringify({ service_name: 'hotel-order-service', env: args.env, circuit_breaker: 'ENABLED', fallback_threshold: 0.05, current_error_rate: 0.082 });
      }
      if (name === 'search_paginated_logs') {
        return JSON.stringify({ logs: ['[CircuitBreaker] Error rate 8.2% exceeds threshold 5%, 32 requests degraded to cache.'], total: 1 });
      }
      return '{}';
    },
    validator: ({ toolCalls, finalText }) => {
      const calledConfig = toolCalls.some(t => t.name === 'get_service_config');
      const calledLogs = toolCalls.some(t => t.name === 'search_paginated_logs');
      const mentionsRisk = /熔断|超标|降级|8\.2%|5%/i.test(finalText);
      const pass = calledConfig && (calledLogs || mentionsRisk);
      const score = (calledConfig ? 50 : 0) + (calledLogs ? 30 : 0) + (mentionsRisk ? 20 : 0);
      return { pass, score, reason: `调配置: ${calledConfig}, 调日志: ${calledLogs}, 命中结论: ${mentionsRisk}` };
    },
  },
  {
    id: 'Orch-4',
    category: 'Orchestration',
    title: '深度嵌套参数结构体调用',
    description: '创建工单工具要求复杂的嵌套对象（audit_details 含 root_cause、responsible_system、tags）',
    userPrompt: '根据排查，订单 ORD_5521 因支付网关签名过期发生技术故障，导致用户资金多扣 500 元。请调用 create_cs_ticket 工具为该用户创建加急退款工单。',
    tools: ORCHESTRATION_TOOLS,
    mockToolExecutor: (name, args) => {
      if (name === 'create_cs_ticket') {
        return JSON.stringify({ success: true, ticket_id: 'TICK_20260822_0099', args });
      }
      return '{}';
    },
    validator: ({ toolCalls }) => {
      const call = toolCalls.find(t => t.name === 'create_cs_ticket');
      if (!call) return { pass: false, score: 0, reason: '未调用 create_cs_ticket' };
      const args = call.args || {};
      const hasOrder = args.order_id === 'ORD_5521';
      const hasAmount = Number(args.amount) === 500;
      const hasDetails = args.audit_details && typeof args.audit_details === 'object';
      const hasCause = hasDetails && Boolean(args.audit_details.root_cause);
      const pass = hasOrder && hasAmount && hasDetails && hasCause;
      let score = 0;
      if (hasOrder) score += 25;
      if (hasAmount) score += 25;
      if (hasDetails) score += 25;
      if (hasCause) score += 25;
      return { pass, score, reason: `订单匹配: ${hasOrder}, 金额匹配: ${hasAmount}, 嵌套详情合规: ${hasDetails}` };
    },
  },
  {
    id: 'Orch-5',
    category: 'Orchestration',
    title: '分页遍历检索与终止识别',
    description: '日志搜索在第 1 页无目标异常，第 2 页才命中，模型需主动翻页并终止',
    userPrompt: '请使用 search_paginated_logs 分页搜索关键字 "Deadlock" 的错误日志，直到找到具体涉及的表名为止。',
    tools: ORCHESTRATION_TOOLS,
    mockToolExecutor: (name, args) => {
      if (name === 'search_paginated_logs') {
        if (Number(args.page) === 1) {
          return JSON.stringify({ page: 1, total_pages: 3, records: ['[INFO] Connection normal', '[INFO] Transaction started'] });
        }
        if (Number(args.page) === 2) {
          return JSON.stringify({ page: 2, total_pages: 3, records: ['[ERROR] Deadlock found when trying to get lock; try restarting transaction: table `t_hotel_inventory`'] });
        }
      }
      return '{}';
    },
    validator: ({ toolCalls, finalText }) => {
      const page2Called = toolCalls.some(t => t.name === 'search_paginated_logs' && Number(t.args?.page) === 2);
      const mentionsTable = finalText.includes('t_hotel_inventory') || /inventory|酒店库存/i.test(finalText);
      const pass = page2Called && mentionsTable;
      const score = (page2Called ? 50 : 0) + (mentionsTable ? 50 : 0);
      return { pass, score, reason: `翻至第2页: ${page2Called}, 提取表名: ${mentionsTable}` };
    },
  },
  {
    id: 'Orch-6',
    category: 'Orchestration',
    title: '无需工具时的纯文本意图快速分流',
    description: '用户仅询问基础常识概念时，模型不应盲目发起无效工具调用，而应直接专业作答',
    userPrompt: '请用简洁明了的 3 点解释什么是分布式锁中的脑裂（Split-brain）现象以及如何避免？',
    tools: ORCHESTRATION_TOOLS,
    mockToolExecutor: () => '{}',
    validator: ({ toolCalls, finalText }) => {
      const noTools = toolCalls.length === 0;
      const highQuality = (finalText.includes('网络分区') || finalText.includes('多数派') || finalText.includes('Quorum') || finalText.includes('Redlock')) && finalText.length >= 80;
      const pass = noTools && highQuality;
      const score = (noTools ? 40 : 0) + (highQuality ? 60 : 20);
      return { pass, score, reason: `未滥用工具: ${noTools}, 阐述专业度: ${highQuality}` };
    },
  },

  // =========================================================================
  // 维度二：执行精度与约束遵循 (Execution - 7 Cases)
  // =========================================================================
  {
    id: 'Exec-1',
    category: 'Execution',
    title: '严格 JSON Schema 与负向字段约束',
    description: '必须输出合法且无代码围栏的裸 JSON，遵守特定枚举，禁止输出 null 或多余键',
    userPrompt: `请分析该排障结果并严格按以下 JSON Schema 输出纯 JSON（禁止包裹任何 Markdown 围栏如 \`\`\`json）：
{
  "troubleshoot_id": "TS-8848",
  "status": "RESOLVED",
  "affected_users": 128,
  "root_cause_category": "DATABASE_LOCK" | "NETWORK_TIMEOUT" | "CODE_BUG",
  "resolution_steps": ["步骤1", "步骤2"],
  "financial_impact": { "currency": "CNY", "amount": 1250.50 }
}
约束：
1. root_cause_category 只能从上述 3 个枚举中取值，当前事故为数据库行锁超时。
2. 绝对不能输出 markdown 代码块标志。
3. financial_impact 的 amount 必须是浮点数，保留两位小数。`,
    validator: ({ finalText }) => {
      const clean = finalText.trim().replace(/^```json\s*/, '').replace(/```$/, '').trim();
      let parsed: any = null;
      try { parsed = JSON.parse(clean); } catch { return { pass: false, score: 0, reason: 'JSON 解析失败' }; }
      const noMarkdown = !finalText.includes('```');
      const hasFields = parsed.troubleshoot_id === 'TS-8848' && parsed.status === 'RESOLVED';
      const validEnum = parsed.root_cause_category === 'DATABASE_LOCK';
      const validAmount = typeof parsed.financial_impact?.amount === 'number';
      const validSteps = Array.isArray(parsed.resolution_steps) && parsed.resolution_steps.length >= 2;
      const pass = noMarkdown && hasFields && validEnum && validAmount && validSteps;
      let score = 0;
      if (noMarkdown) score += 20;
      if (hasFields) score += 20;
      if (validEnum) score += 20;
      if (validAmount) score += 20;
      if (validSteps) score += 20;
      return { pass, score, reason: `无围栏: ${noMarkdown}, 枚举正确: ${validEnum}, 金额数值: ${validAmount}` };
    },
  },
  {
    id: 'Exec-2',
    category: 'Execution',
    title: '复杂条件 SQL 与空值防护生成',
    description: '生成带有 GROUP BY、HAVING、COALESCE、CASE WHEN 的高难度 MySQL 聚合语句',
    userPrompt: `编写一条 MySQL 查询语句，统计 2026 年各商户的有效净结算金额：
表名：t_settlement_record
字段：merchant_id, merchant_name, order_type (1:酒店, 2:机票), trade_amount, refund_amount, status (0:待结, 1:已结, 2:作废), create_time
要求：
1. 只统计 2026 年（create_time）且 status = 1 的记录
2. 净结算金额 = SUM(trade_amount - COALESCE(refund_amount, 0))
3. 统计每个商户的：merchant_id, merchant_name, 酒店订单数（order_type=1），机票订单数（order_type=2），净结算金额
4. 过滤出净结算金额大于 100,000 的商户，并按净结算金额降序排列
仅输出 SQL 语句，无需多余解释。`,
    validator: ({ finalText }) => {
      const sql = finalText.toUpperCase();
      const hasCoalesce = sql.includes('COALESCE') || sql.includes('IFNULL');
      const hasCase = sql.includes('CASE') && (sql.includes('ORDER_TYPE = 1') || sql.includes('ORDER_TYPE=1'));
      const hasHaving = sql.includes('HAVING') && (sql.includes('100000') || sql.includes('100,000'));
      const hasGroupBy = sql.includes('GROUP BY') && sql.includes('MERCHANT_ID');
      const hasYear = sql.includes('2026') || sql.includes('CREATE_TIME');
      const pass = hasCoalesce && hasCase && hasHaving && hasGroupBy && hasYear;
      let score = 0;
      if (hasCoalesce) score += 20;
      if (hasCase) score += 25;
      if (hasHaving) score += 20;
      if (hasGroupBy) score += 20;
      if (hasYear) score += 15;
      return { pass, score, reason: `COALESCE: ${hasCoalesce}, CASE条件: ${hasCase}, HAVING: ${hasHaving}` };
    },
  },
  {
    id: 'Exec-3',
    category: 'Execution',
    title: '批量数据清洗与精确汇算',
    description: '处理 6 行 CSV 记录，根据双重条件计算税额并给出精确总和',
    userPrompt: `处理以下 CSV 数据：
id,name,dept,amount,status
1,张三,研发部,600,PENDING
2,李四,市场部,400,PENDING
3,王五,研发部,300,PENDING
4,赵六,研发部,1200,PENDING
5,孙七,研发部,800,APPROVED
6,周八,客服部,900,PENDING

规则：
1. 筛选【dept="研发部"】且【status="PENDING"】且【amount>=500】的记录：将 status 改为 "AUTO_PASSED"，并计算 tax = amount * 0.08。
2. 其他记录保持原样。
3. 请在输出修改后的完整 CSV 后，在文末严格回答：本次共修改了几条记录？被修改记录的税前总额和累计税额各是多少？`,
    validator: ({ finalText }) => {
      // 满足条件的是 1(张三:600) 和 4(赵六:1200)，共2条。税前总额=1800，税额=1800*0.08=144.00
      const matches2 = finalText.includes('2') || /修改.*[2两]条/i.test(finalText);
      const matches1800 = finalText.includes('1800') || finalText.includes('1,800');
      const matches144 = finalText.includes('144');
      const pass = matches2 && matches1800 && matches144;
      let score = 0;
      if (matches2) score += 34;
      if (matches1800) score += 33;
      if (matches144) score += 33;
      return { pass, score, reason: `修改条数2: ${matches2}, 总额1800: ${matches1800}, 税额144: ${matches144}` };
    },
  },
  {
    id: 'Exec-4',
    category: 'Execution',
    title: '多维正则与报错日志关键元数据精准提取',
    description: '从混杂的 Java 异常栈中精准提取 traceId、耗时、异常类和目标 SQL',
    userPrompt: `从以下日志片段中提取关键元数据：
[2026-08-22 10:15:32.418] [http-nio-8080-exec-9] WARN c.s.h.filter.LogFilter - [traceId=trc_9a8f7b6c5d4e3f2a, spanId=spn_001, cost=3428ms] SlowQueryDetected: class=com.skt.hotel.dao.OrderMapper, method=updateBalanceBatch, sql="UPDATE t_bill SET balance = balance - 120.5 WHERE user_id = 9981 AND version = 3", exception="org.springframework.dao.CannotAcquireLockException: Lock wait timeout exceeded"

请以 Key-Value 格式输出：
1. TraceId:
2. 耗时(毫秒):
3. 异常类型:
4. 发生异常的 Mapper 类名:
5. 扣减的金额数值:`,
    validator: ({ finalText }) => {
      const hasTrace = finalText.includes('trc_9a8f7b6c5d4e3f2a');
      const hasCost = finalText.includes('3428');
      const hasEx = finalText.includes('CannotAcquireLockException');
      const hasMapper = finalText.includes('OrderMapper');
      const hasAmount = finalText.includes('120.5');
      const pass = hasTrace && hasCost && hasEx && hasMapper && hasAmount;
      let score = 0;
      if (hasTrace) score += 20;
      if (hasCost) score += 20;
      if (hasEx) score += 20;
      if (hasMapper) score += 20;
      if (hasAmount) score += 20;
      return { pass, score, reason: `Trace:${hasTrace}, 耗时:${hasCost}, 异常:${hasEx}, 类:${hasMapper}, 金额:${hasAmount}` };
    },
  },
  {
    id: 'Exec-5',
    category: 'Execution',
    title: '精准 TypeScript/JS Bug 最小差异补丁生成',
    description: '修复数组边界与深层空指针异常，仅修改问题行',
    userPrompt: `修复以下 TypeScript 函数中的 Bug（存在空指针解引用和数组越界风险）：
\`\`\`typescript
function getTopVipDiscount(users?: Array<{ name: string; vips?: { level: number; discountRate?: number } }>): number {
  if (users.length === 0) return 1.0;
  const topUser = users[0];
  return topUser.vips.discountRate;
}
\`\`\`
要求：
1. 妥善处理 users 为 undefined / null / 空数组的情况，默认返回 1.0
2. 妥善处理 topUser.vips 或 discountRate 缺失的情况，默认返回 1.0
3. 保持函数签名不变，输出修复后的完整函数。`,
    validator: ({ finalText }) => {
      const handlesOptUsers = finalText.includes('users?.') || finalText.includes('!users') || finalText.includes('users && users.length') || finalText.includes('!users?.length');
      const handlesOptVips = finalText.includes('vips?.') || finalText.includes('topUser?.vips') || finalText.includes('vips.discountRate ??') || finalText.includes('?.discountRate');
      const hasFallback1 = finalText.includes('1.0') || finalText.includes('1');
      const pass = handlesOptUsers && handlesOptVips && hasFallback1;
      let score = 0;
      if (handlesOptUsers) score += 40;
      if (handlesOptVips) score += 40;
      if (hasFallback1) score += 20;
      return { pass, score, reason: `users判空: ${handlesOptUsers}, vips判空: ${handlesOptVips}` };
    },
  },
  {
    id: 'Exec-6',
    category: 'Execution',
    title: '格式转换：Markdown 表格转标准化结构体',
    description: '将复杂 Markdown 文本表格转换为指定 JSON 数组并进行类型转换',
    userPrompt: `将下表转为 JSON 数组：
| 编号 | 服务名 | 端口 | 启用TLS | 超时时间(s) |
| --- | --- | --- | --- | --- |
| S1 | auth-svc | 8001 | true | 5.5 |
| S2 | order-svc | 8002 | false | 10.0 |
| S3 | pay-svc | 8003 | true | 3.0 |

要求：
1. 键名必须英文化：id, serviceName, port (number), tlsEnabled (boolean), timeoutSeconds (number)
2. 类型必须是严格对应的 JS 数据类型（布尔值与数值不能是字符串）
3. 仅输出 JSON 数组。`,
    validator: ({ finalText }) => {
      const clean = finalText.trim().replace(/^```json\s*/, '').replace(/```$/, '').trim();
      let parsed: any = null;
      try { parsed = JSON.parse(clean); } catch { return { pass: false, score: 0, reason: 'JSON 解析失败' }; }
      if (!Array.isArray(parsed) || parsed.length !== 3) return { pass: false, score: 0, reason: '数组长度不符' };
      const s1 = parsed[0];
      const validTypes = typeof s1.port === 'number' && typeof s1.tlsEnabled === 'boolean' && typeof s1.timeoutSeconds === 'number';
      const validValues = s1.id === 'S1' && s1.tlsEnabled === true && s1.port === 8001;
      const pass = validTypes && validValues;
      const score = validTypes ? (validValues ? 100 : 80) : 40;
      return { pass, score, reason: `类型合规: ${validTypes}, 数值准确: ${validValues}` };
    },
  },
  {
    id: 'Exec-7',
    category: 'Execution',
    title: '客服排障三段式报告结构化强约束',
    description: '严格按照 1.问题根因 2.代码与数据佐证 3.客服沟通话术 三段式输出，字数受控',
    userPrompt: `已知：用户因重复点击提交按钮导致同一笔酒店订单在 200ms 内发起两次扣款，防重幂等 Redis 锁由于网络抖动未生效。
请严格输出标准三段式客服排障报告：
【第一部分：排障结论与根因分析】（限 100 字以内）
【第二部分：核心数据与技术佐证】（列出 3 条核心证据点）
【第三部分：客服现成对客沟通答复】（语气温和、包含致歉与已原路退款的提示，限 120 字以内）`,
    validator: ({ finalText }) => {
      const hasPart1 = finalText.includes('第一部分') || finalText.includes('排障结论') || finalText.includes('根因分析');
      const hasPart2 = finalText.includes('第二部分') || finalText.includes('核心数据') || finalText.includes('技术佐证');
      const hasPart3 = finalText.includes('第三部分') || finalText.includes('客服') || finalText.includes('沟通') || finalText.includes('答复');
      const hasApology = /抱歉|非常抱歉|退款|原路/i.test(finalText);
      const pass = hasPart1 && hasPart2 && hasPart3 && hasApology;
      let score = 0;
      if (hasPart1) score += 25;
      if (hasPart2) score += 25;
      if (hasPart3) score += 25;
      if (hasApology) score += 25;
      return { pass, score, reason: `段落完整度: P1=${hasPart1}, P2=${hasPart2}, P3=${hasPart3}, 话术温和度=${hasApology}` };
    },
  },

  // =========================================================================
  // 维度三：深度逻辑推理与高阶智能 (Reasoning - 7 Cases)
  // =========================================================================
  {
    id: 'Reason-1',
    category: 'Reasoning',
    title: '多币种+优惠券+分期手续费资金流水 Balance 冲正核算',
    description: '复杂财务结算场景：用户支付、平台券分摊、酒店手续费扣除、发生部分退款时的精确冲正',
    userPrompt: `请精确计算以下订单的最终对账 Balance：
1. 订单原价: 1000 元。
2. 优惠情况: 用户使用平台券抵扣 100 元（平台出资），商家立减券抵扣 50 元（商家出资）。用户实际微信支付 850 元。
3. 佣金与手续费: 平台按【用户实付 + 平台券】的 10% 收取技术服务费；微信按用户实付收取 0.6% 渠道手续费。
4. 后续发生 50% 部分退款（即退还 50% 房费）：
   - 用户获得实付金额 50% 的现金退款。
   - 平台券按比例退还平台资金 50%。
   - 平台服务费按比例退还 50%。
   - 微信渠道手续费不退还。
请计算并明确给出：
A. 用户收到的实际退款现金是多少元？
B. 平台最终保留的技术服务费是多少元？
C. 微信最终收取的渠道手续费是多少元？
D. 商家最终实际结算到账金额是多少元？（商家到账 = 实际剩余房费价值 - 平台剩余服务费 - 微信不退的手续费 + 平台退回券补）`,
    validator: ({ finalText }) => {
      // A: 用户退款 = 850 * 0.5 = 425.00
      // B: 平台服务费计算基数 = 850 + 100 = 950。原服务费 = 95。退还50%后平台最终保留 = 47.50
      // C: 微信手续费 = 850 * 0.006 = 5.10 (全额不退)
      // D: 商家到账核算：
      //    商家初始应收 = 1000 - 50(自付券) = 950
      //    退款50%后，商家剩余房费收入 = 950 * 0.5 = 475
      //    扣除平台剩余服务费 47.50，扣除微信手续费 5.10 = 475 - 47.50 - 5.10 = 422.40 元
      const has425 = finalText.includes('425');
      const has47_5 = finalText.includes('47.5');
      const has5_1 = finalText.includes('5.1');
      const has422_4 = finalText.includes('422.4') || finalText.includes('422.40');
      const pass = has425 && (has47_5 || has5_1);
      let score = 0;
      if (has425) score += 30;
      if (has47_5) score += 30;
      if (has5_1) score += 20;
      if (has422_4) score += 20;
      return { pass, score, reason: `用户退款425:${has425}, 平台费47.5:${has47_5}, 渠道费5.1:${has5_1}, 商家422.4:${has422_4}` };
    },
  },
  {
    id: 'Reason-2',
    category: 'Reasoning',
    title: '分布式级联超时全链路因果时序归因',
    description: '通过分布式日志时序，从 4 个报错微服务中准确定位真凶服务与受害服务',
    userPrompt: `分析以下微服务调用链的时序与日志，找出根本故障源头：
[10:00:00.100] Gateway -> OrderService /createOrder (Trace: T100)
[10:00:00.120] OrderService -> InventoryService /lockStock (Trace: T100)
[10:00:00.150] InventoryService -> RedisLockCluster (Acquire lock: hotel_102)
[10:00:00.160] InventoryService -> DBCluster /execUpdate (Lock acquired in 10ms)
[10:00:00.180] OrderService -> PaymentService /preAuth (Trace: T100)
[10:00:00.200] PaymentService -> ThirdPartyBankGateway /pay (Trace: T100)
[10:00:05.205] PaymentService: ReadTimeoutException from ThirdPartyBankGateway after 5000ms
[10:00:05.210] OrderService: Received 504 from PaymentService
[10:00:05.215] OrderService -> InventoryService /unlockStock (Compensating tx)
[10:00:05.220] Gateway: 504 Gateway Timeout returned to client.

请回答：
1. 本次故障的【直接受害者】微服务是谁？
2. 本次故障的【第一根本源头】是哪个系统/组件？
3. InventoryService 在 10:00:05.215 执行的操作属于什么机制？
4. 如果重试策略配置为立即重试 3 次，会导致什么潜在次生风险？`,
    validator: ({ finalText }) => {
      const sourceIsBank = /ThirdPartyBankGateway|三方银行|银行网关/i.test(finalText);
      const victimIsGatewayOrOrder = /Gateway|OrderService|网关|订单/i.test(finalText);
      const isCompensation = /补偿|回滚|释放库存|TCC|Saga/i.test(finalText);
      const mentionsRetryRisk = /雪崩|重复扣款|放大流量|重试风暴|加大负载/i.test(finalText);
      const pass = sourceIsBank && isCompensation;
      let score = 0;
      if (sourceIsBank) score += 40;
      if (victimIsGatewayOrOrder) score += 20;
      if (isCompensation) score += 20;
      if (mentionsRetryRisk) score += 20;
      return { pass, score, reason: `根因定位银行:${sourceIsBank}, 补偿机制识别:${isCompensation}, 重试风险:${mentionsRetryRisk}` };
    },
  },
  {
    id: 'Reason-3',
    category: 'Reasoning',
    title: '并发事务死锁交叉时序深度判定',
    description: '两事务在不同隔离级别下的加锁顺序与死锁形成条件分析',
    userPrompt: `在 MySQL InnoDB (RR 隔离级别) 中有两个并发事务 T1 和 T2，表结构为 t_user(id PRIMARY KEY, balance, city_id INDEX)：
时序如下：
时刻 1: T1 执行 SELECT * FROM t_user WHERE id = 10 FOR UPDATE;
时刻 2: T2 执行 SELECT * FROM t_user WHERE id = 20 FOR UPDATE;
时刻 3: T1 执行 UPDATE t_user SET balance = balance + 100 WHERE city_id = 5; (假设匹配到 id=20 和 id=30 两行)
时刻 4: T2 执行 UPDATE t_user SET balance = balance - 50 WHERE id = 10;

请详细推演：
1. 时刻 3 中 T1 会发生什么情况？（获取到锁还是进入等待？为什么？）
2. 时刻 4 中 T2 会发生什么情况？此时系统是否会触发 Deadlock 检测机制？
3. 解释为什么在这个场景下会形成锁环路等待？`,
    validator: ({ finalText }) => {
      const t1WaitsOnT2 = /等待|阻塞|Blocked|持有.*id=20/i.test(finalText);
      const triggersDeadlock = /死锁|Deadlock|锁环路|循环等待/i.test(finalText);
      const explainsLockGraph = /T1.*持有.*id=10.*等待.*id=20.*T2.*持有.*id=20.*等待.*id=10|环路|交叉/i.test(finalText);
      const pass = t1WaitsOnT2 && triggersDeadlock;
      let score = 0;
      if (t1WaitsOnT2) score += 40;
      if (triggersDeadlock) score += 40;
      if (explainsLockGraph) score += 20;
      return { pass, score, reason: `T1等待判定:${t1WaitsOnT2}, 死锁触发判定:${triggersDeadlock}` };
    },
  },
  {
    id: 'Reason-4',
    category: 'Reasoning',
    title: '高维约束推理与微服务拓扑归纳',
    description: '根据 6 个逻辑断言，逆向唯一推断 4 个微服务部署机房与延迟排位',
    userPrompt: `有 4 个微服务 A, B, C, D 分别部署在 4 个机房 (北京、上海、广州、深圳)，且各自 P99 延迟为 10ms, 20ms, 30ms, 40ms（互不相同）：
已知线索：
1. 部署在广州的服务延迟比 A 高，但比部署在深圳的服务延迟低。
2. B 的延迟恰好是 20ms。
3. 部署在上海的服务延迟比 C 严格高 10ms。
4. D 没有部署在深圳。
请通过严格逻辑推理，输出 A, B, C, D 分别部署在哪个机房，以及各自的延迟是多少毫秒。并在最后给出推理步骤。`,
    validator: ({ finalText }) => {
      // 逻辑推导：
      // 由1知：延迟排序 广州 < 深圳，且 A < 广州 < 深圳。因为延迟只有 10,20,30,40，所以 A只能是10ms，广州必须是20ms或30ms，深圳必须是30ms或40ms。
      // 由2知：B=20ms。
      // 因为A=10ms, B=20ms，所以广州=20ms(对应B)，深圳=30ms或40ms。即 B在广州(20ms)。
      // 由3知：上海服务 = C + 10ms。因为C只能是剩余的30ms或40ms，若C=30ms则上海=40ms；若C=40ms则上海=50ms(不存在)。所以 C=30ms，上海=40ms。
      // 此时延迟：A=10ms, B=20ms, C=30ms, D=40ms。
      // 对应机房：A(10ms), B(广州, 20ms), C(30ms), D(上海, 40ms)。
      // 由线索1知 深圳延迟 > 广州(20ms)，且 D在上海(40ms)，所以只能是 C=深圳(30ms)。
      // 剩余机房：A在剩余的北京(10ms)。
      // 最终答案：
      // A: 北京, 10ms
      // B: 广州, 20ms
      // C: 深圳, 30ms
      // D: 上海, 40ms
      const hasA = /A.*(北京|10ms|10\s*毫秒)/i.test(finalText);
      const hasB = /B.*(广州|20ms|20\s*毫秒)/i.test(finalText);
      const hasC = /C.*(深圳|30ms|30\s*毫秒)/i.test(finalText);
      const hasD = /D.*(上海|40ms|40\s*毫秒)/i.test(finalText);
      const pass = hasA && hasB && hasC && hasD;
      let score = 0;
      if (hasA) score += 25;
      if (hasB) score += 25;
      if (hasC) score += 25;
      if (hasD) score += 25;
      return { pass, score, reason: `A:${hasA}, B:${hasB}, C:${hasC}, D:${hasD}` };
    },
  },
  {
    id: 'Reason-5',
    category: 'Reasoning',
    title: '隐蔽代码并发竞态与失效窗口期识别',
    description: '识别双重检查锁（DCL）中由于指令重排与内存可见性引发的空指针穿透',
    userPrompt: `分析以下 Java 单例/缓存管理代码中的隐蔽并发隐患：
\`\`\`java
public class CacheManager {
    private static CacheManager instance;
    private Map<String, Object> cacheStore;

    private CacheManager() {
        this.cacheStore = new HashMap<>();
        this.cacheStore.put("INIT_KEY", "SUCCESS");
    }

    public static CacheManager getInstance() {
        if (instance == null) {
            synchronized (CacheManager.class) {
                if (instance == null) {
                    instance = new CacheManager();
                }
            }
        }
        return instance;
    }
}
\`\`\`
请指出：
1. 在多线程高并发访问时，上述代码可能引发什么偶发异常（如 NPE）？
2. 导致该问题的底层 JVM 原理是什么？（涉及指令重排与实例化步骤）
3. 如何用最轻量的一行关键字修改彻底解决该问题？`,
    validator: ({ finalText }) => {
      const mentionsVolatile = finalText.includes('volatile');
      const mentionsReorder = /指令重排|半初始化|指令重排序|有序性|Memory Barrier/i.test(finalText);
      const mentionsNPE = /NullPointerException|NPE|空指针|未初始化完全/i.test(finalText);
      const pass = mentionsVolatile && mentionsReorder;
      let score = 0;
      if (mentionsVolatile) score += 50;
      if (mentionsReorder) score += 30;
      if (mentionsNPE) score += 20;
      return { pass, score, reason: `命中 volatile:${mentionsVolatile}, 识别指令重排:${mentionsReorder}` };
    },
  },
  {
    id: 'Reason-6',
    category: 'Reasoning',
    title: '乱序 Webhook 异步状态机迁移冲突反推',
    description: '分析乱序到达的消息对状态机最终一致性的破坏并给出幂等补偿算法',
    userPrompt: `某支付系统状态机包含以下状态：
[CREATED] -> [PAYING] -> [PAID] -> [SETTLED]
                      -> [FAILED]
已知：
事件 E1 (PaySuccessWebhook) 和 事件 E2 (CancelByUser) 同时异步发出。
若网络延迟导致 E2 比 E1 先到达服务端：
1. 此时订单状态流转为 FAILED 并已退款给用户。
2. 随后 E1 (支付成功) 延迟 5 秒到达。
问：
A. 如果系统未做逆向状态防护，会产生什么严重的资损风险？
B. 设计一种优雅的状态机防逆流（或版本号乐观锁）机制，请给出核心伪代码或状态跃迁条件。`,
    validator: ({ finalText }) => {
      const mentionsDoublePay = /资损|重复退款|既退款又扣款|双重入账|出票又退款/i.test(finalText);
      const mentionsVersionOrIdempotent = /版本号|乐观锁|CAS|状态跃迁表|幂等|最终一致性|事件溯源/i.test(finalText);
      const pass = mentionsDoublePay && mentionsVersionOrIdempotent;
      let score = 0;
      if (mentionsDoublePay) score += 50;
      if (mentionsVersionOrIdempotent) score += 50;
      return { pass, score, reason: `识别资损风险:${mentionsDoublePay}, 给出防御策略:${mentionsVersionOrIdempotent}` };
    },
  },
  {
    id: 'Reason-7',
    category: 'Reasoning',
    title: '逆向因果推理：从脏数据反推故障代码执行路径',
    description: '数据库中出现优惠券已核销但订单金额未抵扣的脏数据，反推事务边界切分漏洞',
    userPrompt: `线上数据库排查发现一条脏数据：
在 t_coupon_log 表中记录了【优惠券 coupon_8821 状态=USED (已核销)】；
但是在 t_order 表中，对应的订单 ORD_3310 的 coupon_deduct_amount 字段却为 0.00，且实付金额为全额原价。
系统架构为：先调用 CouponService.consumeCoupon() (远程RPC)，再执行本地事务 updateOrder()。

请逆向推导：
1. 到底是在哪一步抛出了什么异常，才会导致这种“券已扣、订单未减”的状态？
2. 为什么本地数据库事务的回滚无法自动修复远程券的核销状态？
3. 从架构层面如何彻底解决此分布式事务不一致问题？（给出至少 2 种业界标准方案）`,
    validator: ({ finalText }) => {
      const identifiesLocalFailure = /本地事务失败|updateOrder.*异常|超时|网络断开|本地回滚/i.test(finalText);
      const explainsDistributedScope = /分布式事务|RPC.*无法回滚|跨服务|两阶段|Saga|TCC|本地事务管不到远程/i.test(finalText);
      const givesSolutions = (/TCC|Saga|事务消息|本地消息表|Seata|最终一致性/i.test(finalText));
      const pass = identifiesLocalFailure && (explainsDistributedScope || givesSolutions);
      let score = 0;
      if (identifiesLocalFailure) score += 35;
      if (explainsDistributedScope) score += 35;
      if (givesSolutions) score += 30;
      return { pass, score, reason: `识别本地失败:${identifiesLocalFailure}, 分布式边界解释:${explainsDistributedScope}, 方案完整:${givesSolutions}` };
    },
  },
];

export interface ExecutionRunResult {
  tier: Tier;
  caseId: string;
  category: string;
  title: string;
  pass: boolean;
  score: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  turns: number;
  reason: string;
  rawOutputSnippet: string;
}

// 执行单次评测运行（支持多轮工具交互）
async function executeSingleRun(tier: Tier, testCase: TestCase): Promise<ExecutionRunResult> {
  const t0 = Date.now();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: testCase.systemPrompt || '你是一个严谨、高智商的技术排障与数据分析专家。请严格遵循约束完成任务。',
    },
    { role: 'user', content: testCase.userPrompt },
  ];

  let turn = 0;
  const maxTurns = 6;
  const toolCallsHistory: Array<{ name: string; args: any }> = [];
  let finalText = '';
  let promptTokens = 0;
  let completionTokens = 0;

  while (turn < maxTurns) {
    turn++;
    try {
      const response = await client.chat.completions.create({
        model: tier,
        messages,
        tools: testCase.tools && testCase.tools.length > 0 ? testCase.tools : undefined,
        tool_choice: testCase.tools && testCase.tools.length > 0 ? 'auto' : undefined,
        temperature: 0.1,
      });

      if (response.usage) {
        promptTokens += response.usage.prompt_tokens || 0;
        completionTokens += response.usage.completion_tokens || 0;
      }

      const choice = response.choices[0];
      if (!choice) break;
      const msg = choice.message;

      if (msg.content) {
        finalText = msg.content;
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // 模型结束交互输出最终答案
        break;
      }

      // 执行模型发起的工具调用
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue;
        const fnName = tc.function.name;
        let parsedArgs: any = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          parsedArgs = { raw: tc.function.arguments };
        }
        toolCallsHistory.push({ name: fnName, args: parsedArgs });

        let toolResult = '{}';
        if (testCase.mockToolExecutor) {
          toolResult = testCase.mockToolExecutor(fnName, parsedArgs, toolCallsHistory);
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    } catch (err: any) {
      finalText += `\n[Error: ${err.message}]`;
      break;
    }
  }

  const durationMs = Date.now() - t0;
  const evalResult = testCase.validator({
    finalText,
    toolCalls: toolCallsHistory,
    turns: turn,
  });

  return {
    tier,
    caseId: testCase.id,
    category: testCase.category,
    title: testCase.title,
    pass: evalResult.pass,
    score: evalResult.score,
    durationMs,
    promptTokens,
    completionTokens,
    turns: turn,
    reason: evalResult.reason,
    rawOutputSnippet: finalText.slice(0, 150).replace(/\n/g, ' '),
  };
}

// 主并发执行引擎
async function runAllBenchmarks() {
  console.log('========================================================================');
  console.log('🚀 启动 Grok 4.6 四大级别深度基准对比评测');
  console.log(`📊 评测规模: 20 个严密基准用例 × 4 个模型级别 = 80 次真实调用`);
  console.log('========================================================================\n');

  const allResults: ExecutionRunResult[] = [];
  const totalTasks = BENCHMARK_TEST_CASES.length * TIERS.length;
  let completed = 0;

  // 按用例顺序，对 4 个模型分批并发测试
  for (const tc of BENCHMARK_TEST_CASES) {
    console.log(`\n▶ [${tc.category}] 测试用例 【${tc.id}: ${tc.title}】 开始...`);
    
    // 对 4 个 Tier 同时发起评测
    const promises = TIERS.map(async (tier) => {
      const res = await executeSingleRun(tier, tc);
      completed++;
      console.log(`  └─ [${tier}] ${res.pass ? '✅ PASS' : '❌ FAIL'} (得分: ${res.score}/100, 耗时: ${res.durationMs}ms) - ${res.reason} [${completed}/${totalTasks}]`);
      return res;
    });

    const results = await Promise.all(promises);
    allResults.push(...results);
  }

  // 输出统计报告
  generateBenchmarkReport(allResults);
}

function generateBenchmarkReport(results: ExecutionRunResult[]) {
  console.log('\n\n========================================================================');
  console.log('📈 评测完成！开始生成统计对比报表...');
  console.log('========================================================================\n');

  // 按模型聚合统计
  const summary: Record<Tier, {
    totalScore: number;
    passCount: number;
    totalRuns: number;
    totalDuration: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    categoryScores: Record<string, { totalScore: number; count: number }>;
  }> = {
    'grok-4.6-low': { totalScore: 0, passCount: 0, totalRuns: 0, totalDuration: 0, totalPromptTokens: 0, totalCompletionTokens: 0, categoryScores: {} },
    'grok-4.6-medium': { totalScore: 0, passCount: 0, totalRuns: 0, totalDuration: 0, totalPromptTokens: 0, totalCompletionTokens: 0, categoryScores: {} },
    'grok-4.6-high': { totalScore: 0, passCount: 0, totalRuns: 0, totalDuration: 0, totalPromptTokens: 0, totalCompletionTokens: 0, categoryScores: {} },
    'grok-4.6-xhigh': { totalScore: 0, passCount: 0, totalRuns: 0, totalDuration: 0, totalPromptTokens: 0, totalCompletionTokens: 0, categoryScores: {} },
  };

  for (const r of results) {
    const s = summary[r.tier];
    s.totalRuns++;
    s.totalScore += r.score;
    if (r.pass) s.passCount++;
    s.totalDuration += r.durationMs;
    s.totalPromptTokens += r.promptTokens;
    s.totalCompletionTokens += r.completionTokens;

    if (!s.categoryScores[r.category]) {
      s.categoryScores[r.category] = { totalScore: 0, count: 0 };
    }
    s.categoryScores[r.category].totalScore += r.score;
    s.categoryScores[r.category].count++;
  }

  // 打印统计表格
  console.log('| 模型级别 | 总得分(均分) | 通过率 (Pass Rate) | 任务编排得分 | 执行精度得分 | 深度推理得分 | 平均耗时(s) | 平均生成Token |');
  console.log('|---|---|---|---|---|---|---|---|');

  for (const tier of TIERS) {
    const s = summary[tier];
    const avgScore = (s.totalScore / s.totalRuns).toFixed(1);
    const passRate = `${((s.passCount / s.totalRuns) * 100).toFixed(1)}% (${s.passCount}/${s.totalRuns})`;
    const orchScore = ((s.categoryScores['Orchestration']?.totalScore || 0) / (s.categoryScores['Orchestration']?.count || 1)).toFixed(1);
    const execScore = ((s.categoryScores['Execution']?.totalScore || 0) / (s.categoryScores['Execution']?.count || 1)).toFixed(1);
    const reasonScore = ((s.categoryScores['Reasoning']?.totalScore || 0) / (s.categoryScores['Reasoning']?.count || 1)).toFixed(1);
    const avgDuration = (s.totalDuration / s.totalRuns / 1000).toFixed(2);
    const avgTokens = (s.totalCompletionTokens / s.totalRuns).toFixed(0);

    console.log(`| **${tier}** | **${avgScore}** | **${passRate}** | ${orchScore} | ${execScore} | ${reasonScore} | ${avgDuration}s | ${avgTokens} |`);
  }

  // 保存详细结果为 JSON 供查验
  fs.writeFileSync('./grok_benchmark_results.json', JSON.stringify({ summary, details: results }, null, 2), 'utf-8');
  console.log('\n💾 完整测试用例详细数据已保存至 ./grok_benchmark_results.json');
}

runAllBenchmarks().catch(console.error);
