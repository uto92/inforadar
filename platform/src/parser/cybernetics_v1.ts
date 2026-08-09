/**
 * サイバネ規格 利用履歴（16バイト固定長）パーサ v1。
 *
 * ■ このファイルの扱いについて
 * バイト配置の解釈は非公式情報に依存している。将来この解釈が変わったときに
 * 過去データを取りこぼさないために、
 *   - 生HEX（raw_observations）は不変で保持する
 *   - パース結果（derived_transactions）は parser_version 付きで全再生成できる
 * という構成にしてある。ここを変更したら必ず PARSER_VERSION を上げ、
 * POST /v1/reparse で全期間を再解析すること。
 *
 * ■ バイト配置（v1 の解釈）
 *   0     : 機器種別
 *   1     : 処理種別
 *   2     : 支払種別
 *   3     : 入出場種別
 *   4-5   : 年月日  YYYYYYYM MMMDDDDD （年は2000年からのオフセット）
 *   6     : 入場 線区コード      （物販系では時刻の上位バイト）
 *   7     : 入場 駅順コード      （物販系では時刻の下位バイト）
 *   8     : 出場 線区コード      （物販系では店舗/端末コード）
 *   9     : 出場 駅順コード
 *   10-11 : 残額（リトルエンディアン, 円）
 *   12-14 : 連番（ビッグエンディアン 24bit）
 *   15    : リージョン（地域）コード
 */

import { isRetailProc } from "./procType";

export const PARSER_VERSION = "cybernetics-v1";

/** 履歴ブロックの固定長（バイト） */
export const HISTORY_BLOCK_BYTES = 16;

export interface ParsedTransaction {
  /** YYYY-MM-DD。日付ビットが空/不正なら null（レコード自体は有効として扱う） */
  usedDate: string | null;
  terminalType: number;
  procType: number;
  paymentType: number;
  entryExitType: number;
  /** "AA-LL-SS"（area-line-station を2桁大文字HEXで連結）。物販系は null */
  entryStationCode: string | null;
  exitStationCode: string | null;
  /** 残額（円） */
  balance: number;
  /** 連番（24bit）。同一カード内の取引順序はこれで決まる */
  seq: number;
  /** リージョンコード。v1 ではこれをそのまま area_code として使う（下記注記参照） */
  regionCode: number;
}

export type ParseResult =
  /** 履歴として解釈できた */
  | { kind: "transaction"; value: ParsedTransaction }
  /** 未使用ブロック（全バイト 0x00）。カードに20枠あるうちの空き枠 */
  | { kind: "blank" }
  /** 解釈できなかった。理由は監査のため必ず持ち回る */
  | { kind: "unparsable"; reason: string };

/**
 * area_code の決め方（v1）
 *
 * 一般に流通している駅コード対応表（StationCode.csv 系）の「エリアコード」と、
 * 履歴ブロック offset 15 の「リージョンコード」の対応は公式には確定していない。
 * v1 では素直に リージョンコード = area_code とみなし、station_master に
 * ヒットしなければコードをそのまま表示する方針を採る。
 * 対応付けを変えるときは PARSER_VERSION を上げて再解析すればよい。
 */
function toStationCode(area: number, line: number, station: number): string {
  return `${hex2(area)}-${hex2(line)}-${hex2(station)}`;
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

/** 空白・区切りを除去して大文字HEXに正規化する。HEXでなければ null */
export function normalizeHex(input: string): string | null {
  const compact = input.replace(/[\s:-]/g, "").toUpperCase();
  if (compact.length === 0 || compact.length % 2 !== 0) return null;
  if (!/^[0-9A-F]+$/.test(compact)) return null;
  return compact;
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * 履歴ブロック1件（32桁HEX）を解釈する。
 * 入力は正規化前でもよい。判定不能なものは例外を投げず unparsable を返す。
 */
export function parseHistoryBlock(rawHex: string): ParseResult {
  const hex = normalizeHex(rawHex);
  if (hex === null) {
    return { kind: "unparsable", reason: "not_hex" };
  }
  if (hex.length !== HISTORY_BLOCK_BYTES * 2) {
    return {
      kind: "unparsable",
      reason: `unexpected_length:${hex.length / 2}bytes`,
    };
  }

  const b = hexToBytes(hex);
  if (b.every((v) => v === 0)) {
    return { kind: "blank" };
  }

  const procType = b[1]!;
  const dateBits = (b[4]! << 8) | b[5]!;
  const usedDate = decodeDate(dateBits);
  const retail = isRetailProc(procType);

  return {
    kind: "transaction",
    value: {
      usedDate,
      terminalType: b[0]!,
      procType,
      paymentType: b[2]!,
      entryExitType: b[3]!,
      entryStationCode: retail ? null : toStationCode(b[15]!, b[6]!, b[7]!),
      exitStationCode: retail ? null : toStationCode(b[15]!, b[8]!, b[9]!),
      // 残額はリトルエンディアン
      balance: b[10]! | (b[11]! << 8),
      seq: (b[12]! << 16) | (b[13]! << 8) | b[14]!,
      regionCode: b[15]!,
    },
  };
}

/**
 * offset 4-5 の日付ビットを YYYY-MM-DD へ。
 * 空（0）や月日が範囲外なら null を返す（レコード自体は捨てない）。
 */
function decodeDate(dateBits: number): string | null {
  if (dateBits === 0) return null;
  const year = 2000 + (dateBits >> 9);
  const month = (dateBits >> 5) & 0x0f;
  const day = dateBits & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
