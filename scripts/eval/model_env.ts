import fs from 'node:fs';
import dotenv from 'dotenv';

/**
 * 评测用的排查模型选择。隔离服务的环境合并顺序是 process.env < server/.env < 这里返回的 env，
 * 所以开关等配置以 server/.env 为准，记录结果时要按同样顺序算"实际生效值"，不能只看父进程。
 */
export type EvalSlot = 'deepseek' | 'gemini' | 'claude';

export function parseSlot(value: string | undefined): EvalSlot {
  return value === 'gemini' || value === 'claude' ? value : 'deepseek';
}

export function slotOptions(slot: EvalSlot): { model: 'deepseek' | 'gemini'; env: Record<string, string> } {
  // EVAL_DEEPSEEK_BASE_URL：对照实验时把 deepseek 接口指到统一参数的记录代理（scripts/eval/model_proxy.mjs）
  if (slot === 'deepseek') return { model: 'deepseek', env: process.env.EVAL_DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: process.env.EVAL_DEEPSEEK_BASE_URL } : {} };
  // gemini 按它在线上时的配置用 json_object（不接受 json_schema）
  if (slot === 'gemini') return { model: 'gemini', env: { MODEL_JSON_FORMAT: 'json_object' } };
  // claude：借 gemini 槽位，指向复核所用的同一个接口（已实测能看图、接受 json_schema）
  const env = dotenv.parse(fs.readFileSync('server/.env'));
  return { model: 'gemini', env: { GEMINI_BASE_URL: env.REVIEW_MODEL_BASE_URL, GEMINI_API_KEY: env.REVIEW_MODEL_API_KEY, GEMINI_MODEL: env.REVIEW_MODEL_NAME } };
}

export function effectiveSwitch(extra: Record<string, string> = {}): string {
  const env = dotenv.parse(fs.readFileSync('server/.env'));
  return extra.REVIEW_OBSERVED_BRANCH ?? env.REVIEW_OBSERVED_BRANCH ?? process.env.REVIEW_OBSERVED_BRANCH ?? 'off';
}

/** 任意配置项的实际生效值：extra（本次传给隔离服务的）> server/.env > 父进程环境 > 缺省 */
export function effectiveEnv(name: string, fallback: string, extra: Record<string, string> = {}): string {
  const env = dotenv.parse(fs.readFileSync('server/.env'));
  return extra[name] ?? env[name] ?? process.env[name] ?? fallback;
}
