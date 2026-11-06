/**
 * Web UI 演示数据：全部为虚构内容（单号、人名、金额均为示例），只用于界面预览与截图，不涉及真实业务数据。
 */
import type { Message } from '../../src/types/index.ts';

interface DemoSession {
  id: string;
  title: string;
  minutesAgo: number;
  messages: Message[];
}

const SYSTEM: Message = { role: 'system', content: '(演示)' };

const call = (id: string, name: string, args: Record<string, unknown>): Message => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, name, arguments: args }],
});
const result = (id: string, name: string, content: string): Message => ({ role: 'tool', tool_call_id: id, name, content });

// 一张简单的示意截图（SVG），模拟客服粘贴的报错界面
const SCREENSHOT =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="#f6f7f9"/><rect x="20" y="20" width="320" height="36" rx="4" fill="#1358a7"/><text x="36" y="44" font-size="15" fill="#fff" font-family="Microsoft YaHei">退票申请</text><circle cx="180" cy="120" r="22" fill="none" stroke="#9aa5b5" stroke-width="5" stroke-dasharray="90 50"/><text x="132" y="175" font-size="14" fill="#5b6577" font-family="Microsoft YaHei">正在加载中…</text></svg>`
  ).toString('base64');

export const DEMO_SESSIONS: DemoSession[] = [
  {
    id: 's_demo_hotel',
    title: '订单 1549900000000000001 出单异常',
    minutesAgo: 6,
    messages: [
      SYSTEM,
      { role: 'user', content: '订单 1549900000000000001 出单异常，帮忙看一下是什么问题' },
      call('d1', 'lookup_order', { id: '1549900000000000001' }),
      result(
        'd1',
        'lookup_order',
        '【单号定位】输入: 1549900000000000001（识别为: 19 位系统单号/ID，检查了 9 个候选表/列）\n✅ 命中 1 处：\n1. 【酒店】skt.skt_hotel_order（按 id 匹配，1 行）\n   - id=1549900000000000001, order_id=1549900000000000002, order_status=1, source=6, carrier=1002, order_amount=328.00, order_time=2026-08-25 13:19:20, fail_reason=供应商返回下单失败\n     时间点: order_time=2026-08-25 13:19:20（可作为 search_logs 的 target_time）'
      ),
      call('d2', 'company_db_query', {
        action: 'query',
        sql: "SELECT order_id, order_status, fail_reason, update_time FROM skt.skt_hotel_order_detail WHERE order_id = '1549900000000000002'",
      }),
      result(
        'd2',
        'company_db_query',
        JSON.stringify({
          status: 'success',
          action: 'query',
          database: 'skt',
          executedSql: "SELECT order_id, order_status, fail_reason, update_time FROM skt.skt_hotel_order_detail WHERE order_id = '1549900000000000002' LIMIT 51",
          rowCount: 2,
          complete: true,
          columns: ['order_id', 'order_status', 'fail_reason', 'update_time'],
          rows: [
            ['1549900000000000002', '1', '供应商返回下单失败', '2026-08-25 13:21:51'],
            ['1549900000000000002', '1', null, '2026-08-25 13:21:52'],
          ],
        })
      ),
      call('d3', 'search_logs', { app: 'cxy-web', keyword: '1549900000000000002', target_time: '2026-08-25 13:19:20', window_minutes: 10 }),
      result(
        'd3',
        'search_logs',
        '=== 日志查询结果: 共 3 条（窗口内全部匹配） ===\n窗口: 2026-08-25 13:09:20 ~ 2026-08-25 13:29:20 | 查询: {namespace="cxy", app="cxy-web"} |= "1549900000000000002" | 按时间正序\n--------------------------------------------------\n2026-08-25 13:21:49 [cxy-web|cxy-web-7d9f] 畅联下单请求 orderId=1549900000000000002\n2026-08-25 13:21:50 [cxy-web|cxy-web-7d9f] 畅联下单返回: status=FAIL, code=ROOM_UNAVAILABLE\n2026-08-25 13:21:51 [cxy-web|cxy-web-7d9f] 订单置为预订取消 orderId=1549900000000000002'
      ),
      call('d4', 'search_code', { keyword: 'ROOM_UNAVAILABLE', scope: 'backend' }),
      result(
        'd4',
        'search_code',
        '【代码检索】关键词: "ROOM_UNAVAILABLE" (实际匹配: ROOM_UNAVAILABLE) | 范围: 后端工程 (skt-back, skt-back-new, skt-remote)\n命中 1 个文件、共 2 处匹配（按路径排序）。下面展示第 1-1 个文件的匹配内容（已展示全部命中文件）。\n\n### skt-back/skt_cxy/cxy-web/src/main/java/com/llb/cxy/sktHotel/hotelXc/service/impl/SktHotelCLOrderServiceImpl.java（2 处匹配）\n410-        HotelOrderResult res = clClient.submit(order);\n411:        if ("ROOM_UNAVAILABLE".equals(res.getCode())) {\n412:            cancelOrder(order, "供应商返回下单失败");'
      ),
      {
        role: 'assistant',
        content: [
          '### 【结论】',
          '**已确认**：这是一张酒店订单（畅联渠道，华住集团）。提交时供应商返回"该房型已满（ROOM_UNAVAILABLE）"，系统按规则自动取消了订单，所以显示出单异常。',
          '',
          '### 【依据】',
          '| 来源 | 关键信息 |',
          '|---|---|',
          '| skt.skt_hotel_order | order_status=1（预订取消），fail_reason=供应商返回下单失败 |',
          '| cxy-web 日志 13:21:50 | 畅联下单返回 status=FAIL，code=ROOM_UNAVAILABLE |',
          '| SktHotelCLOrderServiceImpl.java 第 411–412 行 | 收到 ROOM_UNAVAILABLE 时直接取消订单，不做重试 |',
          '',
          '### 【客服话术】',
          '> 您好，经核实，您预订的酒店在提交时该房型已经满房，酒店未能确认订单，系统已自动取消，已支付的费用会原路退回。建议您重新选择其他房型或酒店预订，给您带来不便非常抱歉。',
          '',
          '### 【还需确认】',
          '- 退款是否已到账：本次没有查询支付流水，客户追问时可以再查 payment.payment_flow。',
        ].join('\n'),
      },
    ],
  },
  {
    id: 's_demo_refund',
    title: '退票提交后一直转圈',
    minutesAgo: 47,
    messages: [
      SYSTEM,
      {
        role: 'user',
        content: [
          { type: 'text', text: '用户张三（手机尾号 7113）提交退票一直转圈，帮我看看' },
          { type: 'image_url', image_url: { url: SCREENSHOT } },
        ],
      },
      call('r1', 'search_code', { keyword: '正在加载中', scope: 'frontend' }),
      result('r1', 'search_code', '【代码检索】关键词: "正在加载中" | 范围: 前端工程 (skt-front)\n命中 3 个文件、共 5 处匹配（按路径排序）。'),
      call('r2', 'company_db_query', { action: 'query', sql: "SELECT air_id, ticket_state, c_date FROM skt.order_air WHERE book_ticket_user_phone LIKE '%7113' AND c_date > '2026-08-18'" }),
      result('r2', 'company_db_query', JSON.stringify({ status: 'success', action: 'query', database: 'skt', rowCount: 1, complete: true, columns: ['air_id', 'ticket_state', 'c_date'], rows: [['1549900000000000301', '9', '2026-08-20 09:12:28']] })),
      {
        role: 'assistant',
        content: [
          '### 【结论】',
          '**推断**：退票申请在后台已经处理成功（ticket_state=9 退票成功），页面一直转圈更可能是前端没有收到接口返回，而不是退票失败。',
          '',
          '### 【依据】',
          '- skt.order_air：air_id=1549900000000000301，ticket_state=9（退票成功），时间 2026-08-20 09:12:28',
          '- 前端页面在等待退票接口返回期间显示"正在加载中"，没有超时提示',
          '',
          '### 【客服话术】',
          '> 您好，系统显示您的退票已经办理成功，页面一直加载可能是网络原因没有刷新出结果，请您退出后重新进入订单页查看。如有其他问题请随时联系我们。',
          '',
          '### 【还需确认】',
          '- 当时的接口日志：日志系统只能查最近的时间窗口，如需确认接口是否超时，请提供用户操作的大致时间。',
        ].join('\n'),
      },
    ],
  },
  {
    id: 's_demo_payment',
    title: '收款收不成功',
    minutesAgo: 60 * 26,
    messages: [
      SYSTEM,
      { role: 'user', content: '刘先生的订单收款一直收不成功，之前点确认收款没反应，查一下原因' },
      call('p1', 'lookup_order', { id: '1549900000000000777' }),
      result('p1', 'lookup_order', '【单号定位失败】输入: 1549900000000000777（识别为: 19 位系统单号/ID）\n❌ 无法连接数据库: 获取数据库连接超时 (6s)。本次没有查询任何业务表，不能据此判断单号是否存在或属于哪条业务线。'),
      {
        role: 'assistant',
        content: [
          '### 【结论】',
          '**无法确定**：数据库暂时连不上，没能查到这笔订单和收款记录，目前不能判断收款失败的原因。',
          '',
          '### 【依据】',
          '- 单号定位：数据库连接超时，没有查询任何业务表',
          '',
          '### 【客服话术】',
          '> 您好，我们正在核实这笔订单的收款情况，查询结果出来后会第一时间回复您，请稍候。',
          '',
          '### 【还需确认】',
          '- 稍后数据库恢复后重新查询；也请提供订单号和点击确认收款的大致时间。',
        ].join('\n'),
      },
    ],
  },
  {
    id: 's_demo_sms',
    title: '三公司领导订票谁能收到短信',
    minutesAgo: 60 * 24 * 5,
    messages: [
      SYSTEM,
      { role: 'user', content: '看看三公司领导订票咱们这边都谁能收到短信，从关联发送配置功能中查' },
      call('m1', 'company_db_query', { action: 'query', sql: "SELECT COUNT(*) FROM skt.skt_msg_send_contact WHERE org_or_user_name LIKE '%三公司%'" }),
      result('m1', 'company_db_query', JSON.stringify({ status: 'success', action: 'query', database: 'skt', rowCount: 1, complete: true, columns: ['COUNT(*)'], rows: [['118']] })),
      {
        role: 'assistant',
        content: '### 【结论】\n**已确认**：共有 9 位同事会收到三公司领导订票的短信，名单见下表。\n\n### 【依据】\n| 接收人 | 部门 | 范围 |\n|---|---|---|\n| 示例甲 | 商旅部 | 全部业务 |\n| 示例乙 | 办公室 | 机票、火车票 |\n\n### 【客服话术】\n> 您好，目前配置为 9 位同事接收领导订票短信，名单已整理给您。',
      },
    ],
  },
];

export function seedDemoSessions(db: { saveSession: (s: { id: string; title: string; createdAt: string; lastActiveAt: string; messages: Message[] }) => void }): void {
  for (const s of DEMO_SESSIONS) {
    const t = new Date(Date.now() - s.minutesAgo * 60 * 1000).toISOString();
    db.saveSession({ id: s.id, title: s.title, createdAt: t, lastActiveAt: t, messages: s.messages });
  }
}
