// 评测脚本侧的用量台账入口：与服务端 server/src/usage_ledger.ts 同一实现、同一份 JSONL，避免两侧格式漂移。
export {
  appendUsageLedger,
  readUsageLedger,
  summarizeUsageLedger,
  usageLedgerPath,
  type UsageLedgerEntry,
  type UsagePurpose,
} from '../../server/src/usage_ledger.ts';
