/// バーコード生値 → 照合キーの正規化。アプリ内で唯一のチョークポイント。
///
/// 方針: 発行元を問わず、来場者が任意のカードを提示できる。
/// 保存するのはソルト付きハッシュのみで、どの会社のカードかは記録しない。
/// アプリ側が知るのは「同じ人が再訪したか」だけになる。
///
/// 実測仕様（WESTER会員証の場合）: 物理カードは Codabar (NW-7) で
/// `A328913579881A` のようにスタート/ストップ記号 [A-Da-d] が付き、
/// ガード除去後のコアが数字ちょうど12桁。
/// ガード記号は symbology の都合で付くものでIDの一部ではないため、
/// どのモードでも除去する（同じカードが常に同じキーになるように）。

export type CardMode =
  /** 発行元を問わず受け付ける（既定） */
  | "any"
  /** WESTER会員証のみ受け付ける（JR西日本との実証用） */
  | "wester12";

export const ID_RULES = {
  /** wester12 モードで要求する桁数 */
  westerLength: 12,
  /**
   * any モードで受け付ける最小長。
   * 極端に短いコードは誤読や無関係な商品コードの可能性が高いため弾く。
   */
  minLengthAny: 8,
};

/** 手入力フォールバックで使う末尾桁数 */
export const SUFFIX_LEN = 6;

export type NormalizeFailure = "empty" | "too_short" | "not_numeric" | "length";

export type NormalizeResult =
  | { ok: true; memberId: string }
  | { ok: false; reason: NormalizeFailure };

/** Codabarのスタート/ストップ記号を除去する（両端そろって付いている場合のみ） */
function stripGuards(text: string): string {
  if (text.length >= 2 && /^[A-Da-d]/.test(text) && /[A-Da-d]$/.test(text)) {
    return text.slice(1, -1);
  }
  return text;
}

export function normalizeScan(rawText: string, mode: CardMode = "any"): NormalizeResult {
  const text = stripGuards(rawText.trim());
  if (!text) return { ok: false, reason: "empty" };

  if (mode === "wester12") {
    if (!/^\d+$/.test(text)) return { ok: false, reason: "not_numeric" };
    if (text.length !== ID_RULES.westerLength) return { ok: false, reason: "length" };
    return { ok: true, memberId: text };
  }

  // any: 発行元も体系も問わない。誤読対策の最小長だけ確認する
  if (text.length < ID_RULES.minLengthAny) return { ok: false, reason: "too_short" };
  return { ok: true, memberId: text };
}
