/* 小康客服助手 Web UI：回答排版与排查步骤说明（纯函数，不依赖 DOM）
 * 浏览器中挂在 window.XkAnswer 上；单元测试用 node:vm 加载同一份文件（tests/client/answer_format.test.ts）。
 * 回答分段和结论把握程度的识别规则与 src/utils/answer_verdict.ts 一致，测试会交叉校验两边的结果。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 回答分段：【结论】【依据】【客服话术】【还需确认】
  // ---------------------------------------------------------------------------
  const KIND_RULES = [
    ['conclusion', /结论/],
    ['script', /话术|回复客户|对客|向.{0,6}(?:用户|客户).{0,8}(?:解释|说明|回复)/],
    ['open', /还需|待确认|需确认|需要确认|待核实|仍需|未确认/],
    ['evidence', /依据|证据|查证|佐证|凭证/],
  ];
  const KIND_LABELS = { conclusion: '结论', evidence: '依据', script: '客服话术', open: '还需确认' };

  function sectionKind(title) {
    for (const [kind, re] of KIND_RULES) if (re.test(title)) return kind;
    return 'other';
  }

  // ### 【结论】 / **【结论】** / 【结论】：xxx
  const BRACKET_LINE = /^[ \t]*(#{1,6}[ \t]*)?(\*\*)?[ \t]*【([^】\n]{1,16})】[ \t]*(\*\*)?[ \t]*[:：]?[ \t]*(.*)$/;
  // **结论**：xxx / **建议这样向用户解释：**
  const BOLD_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?\*\*([^*\n【】]{2,24}?)\*\*[ \t]*([:：]?)[ \t]*(.*)$/;
  // ### 结论 / ### 一、结论 / 原因分析 / ### 💡 结论与建议
  const HEADING_LINE = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

  /** 去掉标题前的序号（一、/ 1. / （二））、emoji 和结尾冒号 */
  function cleanTitle(raw) {
    return String(raw)
      .trim()
      .replace(/^(?:[一二三四五六七八九十]+[、.．]|\d+[.、．)]|[(（][一二三四五六七八九十\d]+[)）])[ \t]*/, '')
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[ \t]*[:：]$/, '')
      .trim();
  }

  function matchSectionLine(line) {
    let m = line.match(BRACKET_LINE);
    if (m) {
      const title = m[3].trim();
      const kind = sectionKind(title);
      let rest = m[5] || '';
      // 正文行首的【酒店】skt.xxx 之类不是段落标题：未知标题必须带 #/** 标记或独占一行
      if (kind === 'other' && !(m[1] || m[2] || m[4]) && rest.trim()) return null;
      // **【结论】已确认**：xxx —— 把被拆开的加粗补回去
      if (m[2] && !m[4] && rest.includes('**')) rest = '**' + rest;
      return { kind, title, rest };
    }
    m = line.match(BOLD_LINE);
    if (m) {
      const title = cleanTitle(m[1]);
      const kind = sectionKind(title);
      const rest = m[3] || '';
      const colon = /[:：][ \t]*$/.test(m[1]) || m[2];
      // 加粗的已知标题，后面要么是冒号、要么独占一行，避免把正文里的"**结论**可能会变"当成标题
      if (kind !== 'other' && title.length <= 16 && (colon || !rest.trim())) return { kind, title, rest };
      return null;
    }
    m = line.match(HEADING_LINE);
    if (m) {
      const title = cleanTitle(m[1]);
      const kind = sectionKind(title);
      if (kind !== 'other' && title.replace(/\s+/g, '').length <= 16) return { kind, title, rest: '' };
    }
    return null;
  }

  function trimFiller(lines) {
    const filler = (l) => /^\s*(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})?\s*$/.test(l);
    let a = 0;
    let b = lines.length;
    while (a < b && filler(lines[a])) a++;
    while (b > a && filler(lines[b - 1])) b--;
    return lines.slice(a, b).join('\n');
  }

  /** 自定义段落标题放在窄标签栏里：取斜杠前的部分（"客服排查建议 / 规避方法" → "客服排查建议"） */
  function shortLabel(title) {
    return String(title).split(/\s*[/／|｜]\s*/)[0].slice(0, 10) || String(title).slice(0, 10);
  }

  function splitSections(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const pre = [];
    const sections = [];
    let cur = null;
    let fence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) fence = !fence;
      const hit = fence ? null : matchSectionLine(line);
      if (hit) {
        cur = { kind: hit.kind, title: hit.title, lines: hit.rest.trim() ? [hit.rest] : [] };
        sections.push(cur);
      } else {
        (cur ? cur.lines : pre).push(line);
      }
    }
    return {
      preamble: trimFiller(pre),
      sections: sections.map((s) => ({
        kind: s.kind,
        title: s.title,
        label: KIND_LABELS[s.kind] || shortLabel(s.title),
        body: trimFiller(s.lines),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 结论把握程度：已确认 / 推断 / 无法确定
  // 只认"标注位置"上的标签（行首、加粗、括号里），出现多个时取最弱的一个，避免把部分推断的结论盖成"已确认"
  // ---------------------------------------------------------------------------
  const VERDICT_TEXT = { confirmed: '已确认', inferred: '推断', unknown: '无法确定' };
  const RANK = { unknown: 0, inferred: 1, confirmed: 2 };
  const VERDICT_PATTERNS = [
    /(?:^|\n)[ \t]*(?:[-*+][ \t]+|\d+[.、)][ \t]*)?(?:\*\*)?[ \t]*[（(【[]?[ \t]*(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)/g,
    /\*\*[ \t]*[（(【[]?[ \t]*(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)/g,
    /[（(【[][ \t]*(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)[ \t]*[)）】\]]/g,
  ];
  const LABEL_ANY = /(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)/;
  const LABEL_COLON = /(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)[ \t]*[:：]/;
  const VERDICT_PREFIX = /^[ \t]*(?:\*\*)?[ \t]*[（(【[]?[ \t]*(?:已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)[ \t]*[)）】\]]?[ \t]*(?:\*\*)?[ \t]*[:：，,。]?[ \t]*(?:\*\*)?[ \t]*/;

  function labelVerdict(label) {
    if (/^(?:无法|不能)/.test(label)) return 'unknown';
    if (/^推/.test(label)) return 'inferred';
    return 'confirmed';
  }

  function verdictLabels(title, body) {
    const found = [];
    const text = String(body || '');
    const t = String(title || '').match(LABEL_ANY);
    if (t) found.push(t[1]);
    for (const re of VERDICT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) found.push(m[1]);
    }
    if (!found.length) {
      const f = text.slice(0, 60).match(LABEL_COLON);
      if (f) found.push(f[1]);
    }
    return found;
  }

  function verdictOf(title, body) {
    let best = null;
    for (const label of verdictLabels(title, body)) {
      const v = labelVerdict(label);
      if (best === null || RANK[v] < RANK[best]) best = v;
    }
    return best;
  }

  function detectVerdict(text) {
    const c = splitSections(text).sections.find((s) => s.kind === 'conclusion');
    return c ? verdictOf(c.title, c.body) : null;
  }

  /** 印章已经表明把握程度时，去掉结论开头重复的"已确认："；结论里混有多种标注时保留原文 */
  function stripVerdictPrefix(title, body) {
    const kinds = new Set(verdictLabels(title, body).map(labelVerdict));
    if (kinds.size !== 1) return body;
    const out = String(body).replace(VERDICT_PREFIX, '');
    return out.trim() ? out : body;
  }

  // ---------------------------------------------------------------------------
  // 排查步骤：把工具调用翻译成客服看得懂的话
  // ---------------------------------------------------------------------------
  const KIND_TEXT = {
    order: '定位单号',
    db: '查数据库',
    logs: '查日志',
    code: '搜代码',
    file: '读代码',
    git: '查修改记录',
    graph: '查调用关系',
    web: '查网络资料',
    plan: '整理计划',
    ask: '向你确认',
    edit: '改文件',
    command: '执行命令',
    other: '其他操作',
  };
  const SCOPE_TEXT = { frontend: '（前端）', backend: '（后端）' };
  const GRAPH_TEXT = {
    definitions: '在哪里定义',
    implementations: '有哪些实现类',
    callers: '被谁调用',
    callees: '调用了哪些方法',
    references: '在哪里被引用',
  };

  function clip(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function baseName(p) {
    const parts = String(p || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function sqlTables(sql) {
    const out = [];
    // 库名.表名，两段都可能带反引号（如 skt.`order`）
    const re = /\b(?:from|join)\s+((?:`[^`]+`|\w+)(?:\s*\.\s*(?:`[^`]+`|\w+))?)/gi;
    let m;
    while ((m = re.exec(String(sql || ''))) !== null) {
      const name = m[1].split('.').pop().replace(/[`\s]/g, '');
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }

  function lineRangeText(start, end) {
    if (!start) return '';
    return end ? ` 第 ${start}–${end} 行` : ` 第 ${start} 行起`;
  }

  function describeToolStep(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    switch (name) {
      case 'lookup_order':
        return { kind: 'order', title: `定位单号 ${clip(a.id, 40)}` };
      case 'company_db_query': {
        const action = a.action || 'query';
        if (action === 'list_databases') return { kind: 'db', title: '查看有哪些数据库' };
        if (action === 'list_tables') {
          return { kind: 'db', title: `查看 ${a.database || 'skt'} 库里的表${a.keyword ? `（名称含「${clip(a.keyword, 30)}」）` : ''}` };
        }
        if (action === 'describe_table') return { kind: 'db', title: `查看表结构 ${a.tableName || ''}`.trim() };
        if (action === 'search_schema') return { kind: 'db', title: `按名称找表「${clip(a.keyword, 30)}」` };
        const tables = sqlTables(a.sql);
        return {
          kind: 'db',
          title: tables.length ? `查数据库 ${tables.slice(0, 3).join('、')}${tables.length > 3 ? ' 等表' : ''}` : '查数据库',
        };
      }
      case 'search_logs': {
        let t = `查日志 ${a.app || '（全部服务）'}`;
        if (a.keyword) t += `「${clip(a.keyword, 40)}」`;
        if (a.target_time) t += `，${a.target_time} 前后`;
        else if (a.start_time) t += `，${a.start_time} 起`;
        else if (a.minutes_ago) t += `，最近 ${a.minutes_ago} 分钟`;
        return { kind: 'logs', title: t };
      }
      case 'list_log_apps':
        return { kind: 'logs', title: '查看哪些服务可以查日志' };
      case 'search_code': {
        let t = `搜代码「${clip(a.keyword, 40)}」${SCOPE_TEXT[a.scope] || ''}`;
        if (a.filePattern) t += `，只看 ${clip(a.filePattern, 30)}`;
        return { kind: 'code', title: t };
      }
      case 'read_file_lines':
        return { kind: 'file', title: `读代码 ${baseName(a.filePath) || clip(a.filePath, 40)}${lineRangeText(a.startLine, a.endLine)}` };
      case 'git_inspect': {
        const range = a.lineRange ? ` 第 ${String(a.lineRange).replace(/\s*,\s*/, '–')} 行` : '';
        const what = a.action === 'blame' ? '查逐行修改人' : '查修改记录';
        return { kind: 'git', title: `${what} ${baseName(a.filePath)}${range}` };
      }
      case 'codegraph_explore':
        return { kind: 'graph', title: `查调用关系 ${clip(a.symbol, 40)} ${GRAPH_TEXT[a.queryType] || ''}`.trim() };
      case 'web_search':
        return { kind: 'web', title: `查网络资料「${clip(a.query, 40)}」` };
      case 'web_fetch':
        return { kind: 'web', title: `打开网页 ${clip(a.url, 60)}` };
      case 'todo_write':
        return { kind: 'plan', title: '整理排查计划' };
      case 'ask_user_question':
        return { kind: 'ask', title: '向你确认' };
      case 'edit_file':
        return { kind: 'edit', title: `修改文件 ${baseName(a.file_path)}` };
      case 'write_file':
        return { kind: 'edit', title: `写入文件 ${baseName(a.file_path)}` };
      case 'run_powershell':
        return { kind: 'command', title: `执行命令 ${clip(a.command, 50)}` };
      default:
        return { kind: 'other', title: `调用 ${name}` };
    }
  }

  function firstLine(s) {
    const line = String(s || '')
      .split('\n')
      .find((l) => l.trim());
    return line ? line.trim() : '';
  }

  /** 从工具返回结果里提炼一句话：state = ok（有结果）/ empty（查了但没有）/ fail（没查成） */
  function summarizeToolResult(name, args, text, isError) {
    const body = String(text == null ? '' : text).replace(/^【重复调用提示】[^\n]*\n/, '');
    const head = firstLine(body);
    const ok = (t) => ({ state: 'ok', text: t || '' });
    const empty = (t) => ({ state: 'empty', text: t });
    const fail = (t) => ({ state: 'fail', text: clip(t, 48) || '执行失败' });

    if (/^工具 \[.*\] 执行超时/.test(body)) return fail('超时，没有结果');
    if (isError || /^工具执行失败[:：]/.test(body)) return fail(head.replace(/^工具执行失败[:：]\s*/, ''));
    if (/^\[操作未执行/.test(body)) return empty('你没有批准，未执行');
    if (/^错误[:：]/.test(body)) return fail(head.replace(/^错误[:：]\s*/, ''));

    switch (name) {
      case 'lookup_order': {
        if (/^【单号定位失败】/.test(body)) {
          return fail(/无法连接数据库/.test(body) ? '数据库连不上，没有查到' : head.replace(/^【单号定位失败】/, ''));
        }
        const hit = body.match(/命中 (\d+) 处/);
        if (hit) {
          const found = [];
          const re = /^\s*\d+\. 【([^】]+)】(?:\w+\.)?(\w+)/gm;
          let m;
          while ((m = re.exec(body)) !== null) found.push(`${m[1]} ${m[2]}`);
          if (!found.length) return ok(`找到 ${hit[1]} 处`);
          return ok(`找到：${found.slice(0, 2).join('、')}${found.length > 2 ? ' 等' : ''}`);
        }
        if (/未能检查/.test(body)) return fail('部分业务表没能查询');
        if (/未命中/.test(body)) return empty('各业务表都没有这个单号');
        return ok('');
      }
      case 'company_db_query': {
        let data = null;
        try {
          data = JSON.parse(body);
        } catch (e) {
          data = null;
        }
        if (!data || typeof data !== 'object') return /失败|错误|超时|无法/.test(head) ? fail(head) : ok('');
        if (data.status === 'security_violation') return fail('不是只读查询，已拦截');
        if (data.status === 'error') return fail(data.message || '查询失败');
        if (Array.isArray(data.rows)) {
          const n = Number(data.rowCount != null ? data.rowCount : data.rows.length);
          if (!n) return empty('没有查到数据');
          return ok(`${n} 行${data.complete === false ? '，只取了一部分' : ''}`);
        }
        if (Array.isArray(data.databases)) return ok(`${data.databases.length} 个库`);
        if (Array.isArray(data.matches)) {
          return data.matches.length ? ok(`找到 ${data.totalMatches || data.matches.length} 张表`) : empty('没有名称匹配的表');
        }
        if (Array.isArray(data.tables)) return data.tables.length ? ok(`${data.tables.length} 张表`) : empty('没有匹配的表');
        if (Array.isArray(data.columns)) return ok(`${data.columns.length} 个字段`);
        return ok('');
      }
      case 'search_logs': {
        if (/^日志查询失败/.test(body)) return fail(head.replace(/^日志查询失败[:：]\s*/, ''));
        if (/^服务端未配置 GRAFANA/.test(body)) return fail('日志系统没有配置');
        if (/没有匹配的日志/.test(head)) return empty('没有匹配的日志');
        let m = body.match(/返回 (\d+) 条（已达到/);
        if (m) return ok(`${m[1]} 条，只取了最近的`);
        m = body.match(/共 (\d+) 条/);
        if (m) return ok(`${m[1]} 条日志`);
        return ok('');
      }
      case 'list_log_apps': {
        if (/失败|未配置/.test(head)) return fail(head);
        try {
          const d = JSON.parse(body);
          if (d && typeof d.count === 'number') return ok(`${d.count} 个服务`);
        } catch (e) {
          /* 不是 JSON 时不提炼 */
        }
        return ok('');
      }
      case 'search_code': {
        if (/未检索到匹配的代码/.test(body)) return empty('没有找到');
        if (/^(?:搜索执行错误|代码检索超时)/.test(body)) return fail(head);
        const m = body.match(/命中 (\d+)(\+?)(?:（已达统计上限）)? 个文件/);
        return ok(m ? `${m[1]}${m[2]} 个文件` : '');
      }
      case 'read_file_lines': {
        if (/^读取文件失败/.test(body)) return fail(head);
        const m = body.match(/【文件】[^\n]*?（共 (\d+) 行）显示第 (\d+)-(\d+) 行/);
        if (m) return ok(`第 ${m[2]}–${m[3]} 行，共 ${m[1]} 行`);
        if (/超出文件长度/.test(body)) return empty('超出文件长度');
        return ok('');
      }
      case 'git_inspect': {
        if (/^(?:Git 查询失败|未找到文件)/.test(body)) return fail(head);
        if (/中没有文件 .+ 的 (?:log|blame) 记录/.test(head)) return empty('没有修改记录');
        return ok('');
      }
      case 'codegraph_explore': {
        if (/【CodeGraph 查询失败】/.test(body)) return fail('图谱查询失败');
        if (/图谱中没有/.test(body)) return empty('图谱里没有记录');
        const m = body.match(/成功匹配 (\d+) 条/);
        return ok(m ? `${m[1]} 条` : '');
      }
      case 'web_search': {
        if (/^互联网搜索(?:不可用|失败)/.test(body)) return fail(head);
        if (/^互联网搜索没有找到/.test(body)) return empty('没有找到');
        return ok('');
      }
      case 'ask_user_question': {
        const m = body.match(/^\[客服已通过交互选项确认结果\][:：]\s*([\s\S]*)$/);
        return ok(m ? `你的回答：${clip(m[1], 40)}` : '');
      }
      default:
        if (/^(?:错误|失败)/.test(head)) return fail(head);
        return ok('');
    }
  }

  // ---------------------------------------------------------------------------
  // 消息内容
  // ---------------------------------------------------------------------------
  function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
    }
    return '';
  }

  /** harness 改写过的占位回复，例如"[本轮没有输出内容]"，不是给客服看的内容 */
  function isPlaceholderReply(text) {
    return /^\[[^\]\n]{0,80}\]$/.test(String(text || '').trim());
  }

  /** 前端发送时把文本附件拼进了消息正文，展示时拆回"正文 + 附件" */
  function parseAskText(text) {
    const files = [];
    const main = String(text || '')
      .replace(/\n*\[附件文件: ([^\]\n]+)\]\n```\n([\s\S]*?)\n```/g, (_m, name, body) => {
        files.push({ name, content: body });
        return '';
      })
      .trim();
    return { main, files };
  }

  // ---------------------------------------------------------------------------
  // Markdown（先整体转义，再识别结构；只生成白名单标签）
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const LIST_ITEM = /^(\s*)([-*+]|\d+[.、)])\s+(.*)$/;

  function inline(s) {
    const codes = [];
    let out = s.replace(/`([^`]+)`/g, (_m, c) => {
      codes.push(c);
      return `\u0001${codes.length - 1}\u0001`;
    });
    out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out.replace(/\u0001(\d+)\u0001/g, (_m, n) => `<code>${codes[Number(n)]}</code>`);
  }

  function isTableStart(lines, i) {
    const a = (lines[i] || '').trim();
    const b = (lines[i + 1] || '').trim();
    return a.length > 1 && a.startsWith('|') && a.endsWith('|') && /^\|(?:\s*:?-+:?\s*\|)+$/.test(b);
  }

  function startsBlock(lines, i) {
    const t = lines[i].trim();
    return (
      /^\u0000CODE\d+\u0000$/.test(t) ||
      isTableStart(lines, i) ||
      /^#{1,6}\s+/.test(t) ||
      /^(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/.test(t) ||
      /^&gt;/.test(t) ||
      LIST_ITEM.test(lines[i])
    );
  }

  function parseTable(lines, start) {
    const cells = (row) =>
      row
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
    const head = cells(lines[start]);
    let i = start + 2;
    const rows = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
      rows.push(cells(lines[i]));
      i++;
    }
    const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
    return { html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, next: i };
  }

  function parseList(lines, start) {
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(LIST_ITEM);
      if (m) {
        const indent = m[1].replace(/\t/g, '    ').length;
        items.push({ level: indent >= 2 ? 1 : 0, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: [m[3]] });
        i++;
        continue;
      }
      // 缩进的续行归入上一条
      if (items.length && /^\s{2,}\S/.test(lines[i]) && !startsBlock(lines, i)) {
        items[items.length - 1].text.push(lines[i].trim());
        i++;
        continue;
      }
      break;
    }
    let html = '';
    let topTag = null;
    let liOpen = false;
    let subTag = null;
    const closeSub = () => {
      if (subTag) html += `</${subTag}>`;
      subTag = null;
    };
    const closeLi = () => {
      closeSub();
      if (liOpen) html += '</li>';
      liOpen = false;
    };
    for (const it of items) {
      const tag = it.ordered ? 'ol' : 'ul';
      const content = it.text.map(inline).join('<br>');
      if (it.level === 0 || !liOpen) {
        if (topTag !== tag) {
          closeLi();
          if (topTag) html += `</${topTag}>`;
          html += tag === 'ol' && it.start > 1 ? `<ol start="${it.start}">` : `<${tag}>`;
          topTag = tag;
        } else {
          closeLi();
        }
        html += `<li>${content}`;
        liOpen = true;
      } else {
        if (subTag !== tag) {
          closeSub();
          html += `<${tag}>`;
          subTag = tag;
        }
        html += `<li>${content}</li>`;
      }
    }
    closeLi();
    if (topTag) html += `</${topTag}>`;
    return { html, next: i };
  }

  function codeBlockHtml(block) {
    const lang = block.lang ? `<span class="code-lang">${block.lang}</span>` : '<span class="code-lang"></span>';
    return `<div class="code"><div class="code-head">${lang}<button type="button" class="code-copy">复制</button></div><pre><code>${block.code}</code></pre></div>`;
  }

  function renderMarkdown(raw) {
    if (!raw) return '';
    const codes = [];
    let text = escapeHtml(String(raw).replace(/\r\n?/g, '\n'));
    // 代码块：允许整块缩进（模型常把代码块写在列表项里），收尾的 ``` 也可以带缩进
    text = text.replace(/(^|\n)([ \t]*)```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*```[^\n]*|$)/g, (_m, lead, indent, lang, code) => {
      const body = indent
        ? code
            .split('\n')
            .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, '')))
            .join('\n')
        : code;
      codes.push({ lang, code: body });
      return `${lead}\n\u0000CODE${codes.length - 1}\u0000\n`;
    });
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      let m;
      if (!t) {
        i++;
        continue;
      }
      if ((m = t.match(/^\u0000CODE(\d+)\u0000$/))) {
        out.push(codeBlockHtml(codes[Number(m[1])]));
        i++;
        continue;
      }
      if (isTableStart(lines, i)) {
        const r = parseTable(lines, i);
        out.push(r.html);
        i = r.next;
        continue;
      }
      if ((m = t.match(/^(#{1,6})\s+(.+?)\s*#*$/))) {
        out.push(`<h4 class="md-h">${inline(m[2])}</h4>`);
        i++;
        continue;
      }
      if (/^(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/.test(t)) {
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^&gt;/.test(t)) {
        const paras = [[]];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
          const q = lines[i].trim().replace(/^&gt;\s?/, '');
          if (q.trim()) paras[paras.length - 1].push(inline(q));
          else paras.push([]);
          i++;
        }
        out.push(`<blockquote>${paras.filter((p) => p.length).map((p) => `<p>${p.join('<br>')}</p>`).join('')}</blockquote>`);
        continue;
      }
      if (LIST_ITEM.test(lines[i])) {
        const r = parseList(lines, i);
        out.push(r.html);
        i = r.next;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
        para.push(inline(lines[i].trim()));
        i++;
      }
      out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
  }

  /** 复制整段回答时去掉 Markdown 标记，便于粘贴到工单或聊天窗口 */
  function toPlainText(markdown) {
    return String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .replace(/^```[^\n]*\n?/gm, '')
      .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/\*\*([^*]+?)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  root.XkAnswer = {
    KIND_LABELS,
    KIND_TEXT,
    VERDICT_TEXT,
    splitSections,
    detectVerdict,
    verdictOf,
    stripVerdictPrefix,
    describeToolStep,
    summarizeToolResult,
    contentText,
    isPlaceholderReply,
    parseAskText,
    escapeHtml,
    renderMarkdown,
    toPlainText,
    clip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
