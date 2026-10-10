import { ServerConfig } from '../types.js';
import { getDbConnectionConfig, withDbConnection, runQuery, QueryTimeoutError, DB_CONNECT_GUIDANCE } from './database.js';

/**
 * 单号定位：给一个单号/票号/PNR，确定性地查各业务主表，返回它属于哪条业务线、主表关键字段和时间锚点。
 * 历史会话中模型拿到 19 位单号只能在 order_air / train_order_ticket / hotel_order 之间撒网猜表，
 * 用 `id = 数字` 触发全表扫描、连环超时，最后按错误的业务线（把酒店单当机票单）给出模板化结论。
 * 这里只查有索引的列（SHOW INDEX 校验后缓存），并把命中、未命中、跳过的情况全部如实列出。
 */

interface LookupTarget {
  label: string;
  database: string;
  table: string;
  column: string;
  keyColumns: string[];
  timeColumns: string[];
  related?: string;
}

const AIR_KEYS = ['air_id', 'order_id', 'pnr_no', 'ticket_no', 'ticket_state', 'customer_name', 'book_ticket_user_name', 'book_ticket_user_org_name', 'route_start_end', 'route_set_out_date', 'receivable_state', 'payable_state', 'account_receivable', 'account_payable', 'c_date'];
const HOTEL_KEYS = ['id', 'order_id', 'order_status', 'source', 'carrier', 'source_order_no', 'source_order_status', 'order_amount', 'order_time', 'c_user_name', 'fail_reason', 'refund_reason', 'is_for_pay', 'pay_origin', 'update_time', 'c_time'];
const TRAIN_KEYS = ['id', 'order_id', 'order_number', 'order_status', 'order_amount', 'order_time', 'ticket_time', 'occupy_seat_fail_msg', 'receivable_state', 'payable_state', 'pay_for_way', 'is_refund_or_change', 'create_time'];
const TAXI_KEYS = ['id', 'order_id', 'order_status', 'source', 'source_order_no', 'source_order_status', 'order_time', 'c_user_name', 'fail_reason', 'is_for_pay', 'pay_origin', 'c_time', 'update_time'];
const ORDER_KEYS = ['order_id', 'order_type', 'order_from', 'order_status', 'c_username', 'c_time', 'income_money', 'outcome_money', 'old_order_no'];

const RELATED = {
  air: '机票相关：skt.order_air 为主表（air_id 主键，order_id 关联 skt.`order`），行程单 skt.air_itinerary，收支 skt.in_expend_customer。',
  hotel: '酒店相关：skt.skt_hotel_order 为主表，明细 skt.skt_hotel_order_detail、费用 skt.skt_hotel_order_business、入住人 skt.skt_hotel_user_info、退订 skt.skt_hotel_refund 均按 order_id 关联。',
  train: '火车票相关：skt.train_order 为主表，车票 skt.train_order_ticket、乘客 skt.train_order_passenger、改签 skt.train_change_info 按 order_id 关联。',
  taxi: '打车相关：skt.taxi_order_info 为主表，业务信息 skt.taxi_business_info（order_id）、应收 skt.taxi_receivable（inside_orderid）。',
  order: '主订单表 skt.`order`：order_type 1=机票 2=火车票 3=保险（其余取值请结合业务表确认）。',
};

const SNOWFLAKE_TARGETS: LookupTarget[] = [
  { label: '主订单', database: 'skt', table: 'order', column: 'order_id', keyColumns: ORDER_KEYS, timeColumns: ['c_time'], related: RELATED.order },
  { label: '机票', database: 'skt', table: 'order_air', column: 'air_id', keyColumns: AIR_KEYS, timeColumns: ['c_date', 'user_create_time'], related: RELATED.air },
  { label: '机票', database: 'skt', table: 'order_air', column: 'order_id', keyColumns: AIR_KEYS, timeColumns: ['c_date', 'user_create_time'], related: RELATED.air },
  { label: '酒店', database: 'skt', table: 'skt_hotel_order', column: 'id', keyColumns: HOTEL_KEYS, timeColumns: ['order_time', 'c_time', 'update_time'], related: RELATED.hotel },
  { label: '酒店', database: 'skt', table: 'skt_hotel_order', column: 'order_id', keyColumns: HOTEL_KEYS, timeColumns: ['order_time', 'c_time', 'update_time'], related: RELATED.hotel },
  { label: '火车票', database: 'skt', table: 'train_order', column: 'order_id', keyColumns: TRAIN_KEYS, timeColumns: ['order_time', 'create_time', 'ticket_time'], related: RELATED.train },
  { label: '火车票', database: 'skt', table: 'train_order', column: 'id', keyColumns: TRAIN_KEYS, timeColumns: ['order_time', 'create_time', 'ticket_time'], related: RELATED.train },
  { label: '打车', database: 'skt', table: 'taxi_order_info', column: 'id', keyColumns: TAXI_KEYS, timeColumns: ['order_time', 'c_time'], related: RELATED.taxi },
  { label: '打车', database: 'skt', table: 'taxi_order_info', column: 'order_id', keyColumns: TAXI_KEYS, timeColumns: ['order_time', 'c_time'], related: RELATED.taxi },
];

const TICKET_TARGETS: LookupTarget[] = [
  { label: '机票(票号)', database: 'skt', table: 'order_air', column: 'ticket_no', keyColumns: AIR_KEYS, timeColumns: ['c_date', 'user_create_time'], related: RELATED.air },
];
const PNR_TARGETS: LookupTarget[] = [
  { label: '机票(PNR)', database: 'skt', table: 'order_air', column: 'pnr_no', keyColumns: AIR_KEYS, timeColumns: ['c_date', 'user_create_time'], related: RELATED.air },
];
const SUPPLIER_TARGETS: LookupTarget[] = [
  { label: '酒店(供应商单号)', database: 'skt', table: 'skt_hotel_order', column: 'source_order_no', keyColumns: HOTEL_KEYS, timeColumns: ['order_time', 'c_time', 'update_time'], related: RELATED.hotel },
  { label: '打车(供应商单号)', database: 'skt', table: 'taxi_order_info', column: 'source_order_no', keyColumns: TAXI_KEYS, timeColumns: ['order_time', 'c_time'], related: RELATED.taxi },
];
const TRAIN_12306_TARGETS: LookupTarget[] = [
  { label: '火车票(12306订单号)', database: 'skt', table: 'train_order', column: 'order_number', keyColumns: TRAIN_KEYS, timeColumns: ['order_time', 'create_time', 'ticket_time'], related: RELATED.train },
];

export interface IdentifierClass {
  normalized: string;
  kind: string;
  targets: LookupTarget[];
  advice?: string;
}

export function classifyIdentifier(raw: string): IdentifierClass {
  const compact = String(raw || '').trim().replace(/\s+/g, '');
  if (/^\d{3}-\d{10}$/.test(compact)) {
    return { normalized: compact.replace('-', ''), kind: '13 位机票票号', targets: TICKET_TARGETS };
  }
  if (/^\d{17,20}$/.test(compact)) {
    return { normalized: compact, kind: `${compact.length} 位系统单号/ID`, targets: SNOWFLAKE_TARGETS };
  }
  if (/^\d{13}$/.test(compact)) {
    return { normalized: compact, kind: '13 位机票票号', targets: TICKET_TARGETS };
  }
  if (/^\d{14,16}$/.test(compact)) {
    return { normalized: compact, kind: `${compact.length} 位供应商单号（携程/渠道等）`, targets: SUPPLIER_TARGETS };
  }
  if (/^1[3-9]\d{9}$/.test(compact)) {
    return {
      normalized: compact,
      kind: '11 位手机号',
      targets: [],
      advice: '这是手机号不是单号。请用 company_db_query 按手机号查人员（如 skt.sys_user_info.mobile_phone）或按预订人/联系人手机号查订单。',
    };
  }
  if (/^E\d{9}$/i.test(compact)) {
    return { normalized: compact.toUpperCase(), kind: '12306 订单号', targets: TRAIN_12306_TARGETS };
  }
  if (/^[A-Z0-9]{6}$/i.test(compact) && /[A-Z]/i.test(compact)) {
    return { normalized: compact.toUpperCase(), kind: '6 位 PNR 编码', targets: PNR_TARGETS };
  }
  return {
    normalized: compact,
    kind: '无法识别的格式',
    targets: [],
    advice: '无法根据格式判断单号类型。请向客服确认这是哪个系统的单号（我方订单号 / 供应商单号 / 12306 / 航司票号 / PNR），或用 company_db_query 直接查询已知表。',
  };
}

// 表索引缓存：只对有索引的列做等值查询，避免全表扫描
const indexCache = new Map<string, { columns: Set<string>; at: number }>();
const INDEX_CACHE_TTL_MS = 30 * 60 * 1000;

export function _resetIndexCacheForTests(): void {
  indexCache.clear();
}

async function getIndexedLeadingColumns(database: string, table: string): Promise<Set<string> | null> {
  const key = `${database}.${table}`.toLowerCase();
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.at < INDEX_CACHE_TTL_MS) return cached.columns;
  try {
    const columns = await withDbConnection(async (ctx) => {
      await runQuery(ctx, `USE \`${database}\``, undefined, 5000, '切换数据库');
      const [rows] = await runQuery<any[]>(ctx, `SHOW INDEX FROM \`${table}\``, undefined, 5000, '查询索引');
      const set = new Set<string>();
      for (const r of rows as Array<Record<string, any>>) {
        if (Number(r.Seq_in_index) === 1) set.add(String(r.Column_name).toLowerCase());
      }
      return set;
    });
    indexCache.set(key, { columns, at: Date.now() });
    return columns;
  } catch {
    return null;
  }
}

interface TargetOutcome {
  target: LookupTarget;
  status: 'matched' | 'not_found' | 'skipped' | 'error';
  rows?: Array<Record<string, unknown>>;
  message?: string;
}

function pickFields(row: Record<string, unknown>, keyColumns: string[]): string {
  const parts: string[] = [];
  for (const col of keyColumns) {
    if (!(col in row)) continue;
    const v = row[col];
    if (v === null || v === undefined || v === '') continue;
    let s = String(v);
    if (s.length > 80) s = s.slice(0, 80) + '…';
    parts.push(`${col}=${s}`);
  }
  if (parts.length === 0) {
    for (const [k, v] of Object.entries(row).slice(0, 12)) {
      if (v !== null && v !== undefined && v !== '') parts.push(`${k}=${String(v).slice(0, 80)}`);
    }
  }
  return parts.join(', ');
}

async function lookupTarget(target: LookupTarget, id: string): Promise<TargetOutcome> {
  const indexed = await getIndexedLeadingColumns(target.database, target.table);
  if (indexed === null) {
    return { target, status: 'error', message: '无法读取该表索引信息（表可能不存在或无权限）' };
  }
  if (!indexed.has(target.column.toLowerCase())) {
    return { target, status: 'skipped', message: '该列没有索引，为避免全表扫描未查询' };
  }
  try {
    const rows = await withDbConnection(async (ctx) => {
      await runQuery(ctx, `USE \`${target.database}\``, undefined, 5000, '切换数据库');
      const [result] = await runQuery<any[]>(
        ctx,
        `SELECT * FROM \`${target.database}\`.\`${target.table}\` WHERE \`${target.column}\` = ? LIMIT 3`,
        [id],
        6000,
        '单号查询'
      );
      return result as Array<Record<string, unknown>>;
    });
    return rows.length > 0 ? { target, status: 'matched', rows } : { target, status: 'not_found' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { target, status: 'error', message: err instanceof QueryTimeoutError ? `${msg}（已尝试终止查询）` : msg };
  }
}

function targetName(t: LookupTarget): string {
  return `${t.label} ${t.database}.${t.table}.${t.column}`;
}

export async function executeLookupOrder(args: { id: string }, _config: ServerConfig): Promise<string> {
  const raw = String(args.id || '').trim();
  if (!raw) return '错误: id 参数不能为空（传入单号/票号/PNR）。';
  if (!getDbConnectionConfig()) {
    return '服务端未配置数据库连接（COMPANY_DB_*），无法定位单号。';
  }

  const cls = classifyIdentifier(raw);
  if (cls.targets.length === 0) {
    return `【单号定位】输入: ${raw}（识别为: ${cls.kind}）\n${cls.advice}`;
  }

  // 先做一次连通性检查：库不可达时快速失败，而不是对每个候选表逐个等待超时
  try {
    await withDbConnection((ctx) => runQuery(ctx, 'SELECT 1', undefined, 5000, '连通性检查'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `【单号定位失败】输入: ${raw}（识别为: ${cls.kind}）\n❌ ${msg}。本次没有查询任何业务表，不能据此判断单号是否存在或属于哪条业务线。\n${DB_CONNECT_GUIDANCE}`;
  }

  const outcomes: TargetOutcome[] = [];
  const queue = [...cls.targets];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift()!;
      outcomes.push(await lookupTarget(t, cls.normalized));
    }
  });
  await Promise.all(workers);
  const order = new Map(cls.targets.map((t, i) => [t, i]));
  outcomes.sort((a, b) => (order.get(a.target)! - order.get(b.target)!));

  const matched = outcomes.filter((o) => o.status === 'matched');
  const notFound = outcomes.filter((o) => o.status === 'not_found');
  const problems = outcomes.filter((o) => o.status === 'skipped' || o.status === 'error');

  const title = matched.length === 0 && notFound.length === 0 ? '【单号定位失败】' : '【单号定位】';
  const lines: string[] = [`${title}输入: ${raw}（识别为: ${cls.kind}，检查了 ${cls.targets.length} 个候选表/列）`];

  if (matched.length > 0) {
    lines.push(`✅ 命中 ${matched.length} 处：`);
    matched.forEach((o, idx) => {
      const t = o.target;
      lines.push(`${idx + 1}. 【${t.label}】${t.database}.${t.table}（按 ${t.column} 匹配，${o.rows!.length} 行）`);
      for (const row of o.rows!) {
        let fields = pickFields(row, t.keyColumns);
        if (t.table === 'order' && row.order_type != null) {
          const label = { '1': '机票', '2': '火车票', '3': '保险' }[String(row.order_type)];
          if (label) fields += `（order_type=${row.order_type} 即 ${label}）`;
        }
        lines.push(`   - ${fields}`);
        const times = t.timeColumns.filter((c) => row[c]).map((c) => `${c}=${row[c]}`);
        if (times.length) lines.push(`     时间点: ${times.join(', ')}（可作为 search_logs 的 target_time）`);
      }
    });
    const relatedNotes = Array.from(new Set(matched.map((o) => o.target.related).filter(Boolean)));
    lines.push('下一步: 后续查询请以命中的主表为准，不要再到其他业务表里猜。', ...relatedNotes.map((r) => `- ${r}`));
  } else {
    lines.push('❌ 在下面所有候选主表中都没有找到这个单号。');
  }

  if (notFound.length) {
    lines.push(`未命中（已查询，0 行）: ${notFound.map((o) => targetName(o.target)).join('；')}`);
  }
  if (problems.length) {
    lines.push(`未能检查: ${problems.map((o) => `${targetName(o.target)}（${o.message}）`).join('；')}`);
  }
  if (matched.length === 0) {
    lines.push(
      problems.length
        ? '由于部分候选表未能检查，不能断定单号不存在。可以稍后重试，或用 company_db_query 带索引条件查询对应表。'
        : '可能原因：单号输入有误、属于其他业务线（如保险/用车）、或是供应商/12306/航司侧的单号。请向客服确认单号来源，不要据此直接下"订单不存在"的结论。'
    );
  }
  return lines.join('\n');
}
