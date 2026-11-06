// M4-1：盲评包生成。同一题目的多个候选答案用带固定种子的确定性伪随机数（Mulberry32）打乱，
// 标记为 候选 A/B/C；彻底剥离 variant/model/seconds/timestamp/traceId/reviewStatus 等身份信息。
// "盲评字母 -> 真实候选" 的映射单独写 blind-key.json，严禁出现在盲评页。
// 用法: node --import tsx scripts/eval/make_blind_pack.ts <records.json> <out-dir> [seed]
import fs from 'node:fs';
import path from 'node:path';

export interface BlindCandidate {
  candidateId: string;
  answer: string;
}
export interface BlindTicket {
  ticketId: string;
  question: string;
  candidates: BlindCandidate[];
}
export interface BlindPackResult {
  seed: number;
  packText: string;
  key: { seed: number; tickets: Array<{ ticketId: string; key: Record<string, string> }> };
}

/** 盲评页中严禁出现的身份字样（生成后自检） */
const FORBIDDEN_TOKENS = ['baseline', 'candidate', 'gemini', 'flash', 'deepseek', 'reasoning_effort', 'traceId', 'reviewStatus'];

/** Mulberry32：小巧的确定性 PRNG，种子写进包头保证可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 洗牌（确定性） */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function buildBlindPack(tickets: readonly BlindTicket[], seed = 20261015): BlindPackResult {
  const random = mulberry32(seed);
  const pages: string[] = [`# 盲评包（seed=${seed}）`, '', `> 本包已隐去全部候选身份信息；请只依据答案内容与随附打分表逐条评判。`, ''];
  const key: BlindPackResult['key'] = { seed, tickets: [] };
  for (const ticket of tickets) {
    const ordered = shuffle(ticket.candidates, random);
    const letterKey: Record<string, string> = {};
    pages.push(`## 工单 ${ticket.ticketId}`, '', `**问题**：${ticket.question}`, '');
    ordered.forEach((candidate, index) => {
      const letter = LETTERS[index];
      letterKey[letter] = candidate.candidateId;
      pages.push(`### 候选 ${letter}`, '', candidate.answer.trim(), '');
    });
    key.tickets.push({ ticketId: ticket.ticketId, key: letterKey });
  }
  const packText = pages.join('\n');
  for (const token of FORBIDDEN_TOKENS) {
    if (packText.toLowerCase().includes(token.toLowerCase())) throw new Error(`盲评包包含身份字样 "${token}"，拒绝输出`);
  }
  return { seed, packText, key };
}

function main(): void {
  const [recordsPath, outDir, seedArg] = process.argv.slice(2);
  if (!recordsPath || !outDir) {
    console.error('用法: node --import tsx scripts/eval/make_blind_pack.ts <records.json> <out-dir> [seed]');
    process.exitCode = 1;
    return;
  }
  const seed = Number(seedArg || 20261015);
  const tickets = JSON.parse(fs.readFileSync(recordsPath, 'utf8')) as BlindTicket[];
  const { packText, key } = buildBlindPack(tickets, seed);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'blind-pack.md'), packText);
  fs.writeFileSync(path.join(outDir, 'blind-key.json'), JSON.stringify(key, null, 2));
  console.log(`盲评包: ${tickets.length} 个工单 / ${tickets.reduce((n, t) => n + t.candidates.length, 0)} 个候选，seed=${seed}`);
  console.log(`产物: ${path.join(outDir, 'blind-pack.md')}（可外发）+ blind-key.json（仅留底，严禁外发）`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('make_blind_pack.ts')) main();
