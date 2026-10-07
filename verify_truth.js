import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.COMPANY_DB_HOST,
  port: Number(process.env.COMPANY_DB_PORT || 8066),
  user: process.env.COMPANY_DB_USER,
  password: process.env.COMPANY_DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 3,
  connectTimeout: 8000,
  multipleStatements: false,
  bigNumberStrings: true,
  supportBigNumbers: true,
});

async function run(label, sql) {
  console.log(`\n===== ${label} =====`);
  try {
    const [rows] = await pool.query(sql);
    console.log(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}

// 1. 通过手机号找到该用户的所有订单号
await run('1. 订单号列表 (phone=18053271039)', "SELECT order_id, passenger_name, phone FROM skt.train_order_passenger WHERE phone = '18053271039' LIMIT 50");

// 2. 这些订单的所有火车票 + 退票费（通过 order_id 关联 business）
await run('2. 全部票+退票费 (JOIN business on order_id)', "SELECT t.id AS ticket_id, t.order_id, t.ticket_number, t.train_no, t.from_station_name, t.to_station_name, t.train_date, t.ticket_state, t.train_ticket_type, t.ticket_price, b.refund_fee, b.change_fee, b.service_charge, b.account_payable, b.account_receivable FROM skt.train_order_ticket t LEFT JOIN skt.train_order_ticket_business b ON t.order_id = b.order_id AND t.ticket_number = b.ticket_number WHERE t.order_id IN (SELECT order_id FROM skt.train_order_passenger WHERE phone = '18053271039') ORDER BY t.train_date LIMIT 80");

// 3. 只看有退票费的票 (refund_fee > 0)
await run('3. 仅有退票费的票 (refund_fee > 0)', "SELECT t.id AS ticket_id, t.order_id, t.ticket_number, t.train_no, t.from_station_name, t.to_station_name, t.train_date, t.ticket_state, t.train_ticket_type, t.ticket_price, b.refund_fee, b.change_fee FROM skt.train_order_ticket t JOIN skt.train_order_ticket_business b ON t.order_id = b.order_id AND t.ticket_number = b.ticket_number WHERE t.order_id IN (SELECT order_id FROM skt.train_order_passenger WHERE phone = '18053271039') AND b.refund_fee > 0 LIMIT 50");

// 4. 账单票明细（用字符串 bill_id 避免精度丢失）
await run('4. 账单 finance_bill_booker (宋肖肖 2026-03)', "SELECT bill_id, bill_name, bill_date, booker_name, booker_id FROM skt.finance_bill_booker WHERE booker_name = '宋肖肖' AND bill_date LIKE '2026-03%' LIMIT 10");

await pool.end();
