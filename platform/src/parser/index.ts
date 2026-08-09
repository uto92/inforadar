/**
 * パーサの入口。
 *
 * 将来 v2 を足すときは、この層で PARSER_VERSION に応じて実装を切り替える。
 * 呼び出し側（derive.ts）はバージョンの中身を知らなくてよい。
 */
export {
  PARSER_VERSION,
  HISTORY_BLOCK_BYTES,
  parseHistoryBlock,
  normalizeHex,
} from "./cybernetics_v1";
export type { ParsedTransaction, ParseResult } from "./cybernetics_v1";
export { procTypeLabel, isRetailProc, PROC_TYPE_LABELS } from "./procType";
