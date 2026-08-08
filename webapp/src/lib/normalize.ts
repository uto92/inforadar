/// バーコード生値 → WESTER会員ID の正規化。アプリ内で唯一のチョークポイント。
///
/// 実測仕様: 物理カードは Codabar (NW-7) で `A328913579881A` のように
/// スタート/ストップ記号 [A-Da-d] が付く。ガード除去後のコアが数字ちょうど12桁。
/// QR / Code128 の場合は12桁数字がそのまま入っている前提。

export const ID_RULES = {
  exactLength: 12,
  /** 社内仕様が判明したら設定（例: "32"）。null の間は無効 */
  requiredPrefix: null as string | null,
};

/** 手入力フォールバックで使う末尾桁数 */
export const SUFFIX_LEN = 6;

export type NormalizeFailure = "empty" | "not_numeric" | "length" | "prefix";

export type NormalizeResult =
  | { ok: true; memberId: string }
  | { ok: false; reason: NormalizeFailure };

export function normalizeScan(rawText: string): NormalizeResult {
  let text = rawText.trim();
  if (!text) return { ok: false, reason: "empty" };
  // Codabarのスタート/ストップ記号は両端そろって付いている場合のみ除去
  if (text.length >= 2 && /^[A-Da-d]/.test(text) && /[A-Da-d]$/.test(text)) {
    text = text.slice(1, -1);
  }
  if (!/^\d+$/.test(text)) return { ok: false, reason: "not_numeric" };
  if (text.length !== ID_RULES.exactLength) return { ok: false, reason: "length" };
  if (ID_RULES.requiredPrefix && !text.startsWith(ID_RULES.requiredPrefix)) {
    return { ok: false, reason: "prefix" };
  }
  return { ok: true, memberId: text };
}
