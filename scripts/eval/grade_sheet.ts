// M4-2：打分表。生成四栏模板（参考答案要点 / 禁止断言 / 核心诉求 / 适用范围，每栏 符合|否决|修改 + 备注），
// 并解析人工填写后的表格，供 workbook/agreement 消费。
// 用法: node --import tsx scripts/eval/grade_sheet.ts <blind-pack.md|tickets.json> <out.md|in.md>
import fs from 'node:fs';
import path from 'node:path';

export const GRADE_COLUMNS = ['参考答案要点', '禁止断言', '核心诉求', '适用范围'] as const;
export type GradeColumn = (typeof GRADE_COLUMNS)[number];
export const VERDICTS = ['符合', '否决', '修改'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** blind-key.json 的工单条目：盲评字母 -> 真实候选 ID 的映射 */
export interface BlindKeyTicket {
  ticketId: string;
  key: Record<string, string>;
}

/** 从 blind-key.json 生成打分表模板（按字母评分，避免身份泄露） */
export function templateFromKey(key: { tickets: BlindKeyTicket[] }): string {
  const lines = ['# 盲评打分表', '', '> 每栏三选一：符合 / 否决 / 修改；"修改"请在备注里写明应该怎么改。', ''];
  for (const ticket of key.tickets) {
    lines.push(`## 工单 ${ticket.ticketId}`, '');
    lines.push(['候选', ...GRADE_COLUMNS, '备注'].map(cell => `| ${cell}`).join(' ') + ' |');
    lines.push(['---', ...GRADE_COLUMNS.map(() => '---'), '---'].map(cell => `| ${cell}`).join(' ') + ' |');
    for (const letter of Object.keys(ticket.key).sort()) lines.push([`候选 ${letter}`, '', '', '', '', ''].map(cell => `| ${cell}`).join(' ') + ' |');
    lines.push('');
  }
  return lines.join('\n');
}

export interface ParsedGrade {
  ticketId: string;
  letter: string;
  verdicts: Partial<Record<GradeColumn, Verdict>>;
  note: string;
}

/** 解析填写后的打分表（markdown 表格；单元格须为 符合/否决/修改 之一，空单元格按未评处理） */
export function parseGradeSheet(markdown: string): ParsedGrade[] {
  const grades: ParsedGrade[] = [];
  let ticketId = '';
  for (const rawLine of markdown.split('\n')) {
    const heading = /^##\s*工单\s+(\S+)/.exec(rawLine.trim());
    if (heading) { ticketId = heading[1]; continue; }
    const line = rawLine.trim();
    if (!line.startsWith('|') || !ticketId) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const letterMatch = /^候选\s+([A-F])$/.exec(cells[0] || '');
    if (!letterMatch) continue;
    const verdicts: Partial<Record<GradeColumn, Verdict>> = {};
    GRADE_COLUMNS.forEach((column, index) => {
      const value = cells[index + 1];
      if ((VERDICTS as readonly string[]).includes(value)) verdicts[column] = value as Verdict;
    });
    grades.push({ ticketId, letter: letterMatch[1], verdicts, note: cells[GRADE_COLUMNS.length + 1] || '' });
  }
  return grades;
}

/** 一栏"否决"即整体否决（任一阵营被判否决，该候选不可交付） */
export function candidateRejected(grade: ParsedGrade): boolean {
  return Object.values(grade.verdicts).some(verdict => verdict === '否决');
}

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('用法: node --import tsx scripts/eval/grade_sheet.ts <blind-key.json|filled.md> <out.md|parsed.json>');
    process.exitCode = 1;
    return;
  }
  if (input.endsWith('.json')) {
    const key = JSON.parse(fs.readFileSync(input, 'utf8')) as { tickets: BlindKeyTicket[] };
    fs.writeFileSync(output, templateFromKey(key));
    console.log(`打分表模板: ${key.tickets.length} 个工单，四栏 × 符合/否决/修改`);
  } else {
    const grades = parseGradeSheet(fs.readFileSync(input, 'utf8'));
    fs.writeFileSync(output, JSON.stringify(grades, null, 2));
    console.log(`解析打分表: ${grades.length} 行，其中否决 ${grades.filter(candidateRejected).length} 行`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('grade_sheet.ts')) main();
