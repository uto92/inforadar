/**
 * 処理種別（サイバネ規格 履歴ブロック offset 1）の対応表。
 *
 * 出典は非公式情報（felicalib 系のサンプル実装で広く共有されている値）であり、
 * 一次資料で検証されたものではない。ここを直したら parser_version を上げること。
 */
export const PROC_TYPE_LABELS: Readonly<Record<number, string>> = {
  1: "運賃支払",
  2: "チャージ",
  3: "券購（磁気券購入）",
  4: "精算",
  5: "精算（入場精算）",
  6: "窓出（改札窓口処理）",
  7: "新規（新規発行）",
  8: "控除",
  13: "バス（PiTaPa系）",
  15: "バス（IruCa系）",
  17: "再発行",
  19: "支払（新幹線利用）",
  20: "入A（入場時オートチャージ）",
  21: "出A（出場時オートチャージ）",
  31: "入金（バスチャージ）",
  35: "券購（バス企画券購入）",
  70: "物販",
  72: "特典（特典チャージ）",
  73: "入金（レジ入金）",
  74: "物販取消",
  75: "入物（入場物販）",
  132: "精算（他社精算）",
  133: "精算（他社入場精算）",
  198: "物現（現金併用物販）",
  203: "入物（現金併用入場物販）",
};

/**
 * 物販系の処理種別。
 * このグループでは offset 6-7 が「駅」ではなく「時刻」、offset 8-9 が
 * 店舗/端末コードになるため、駅コードとして解釈してはいけない。
 */
const RETAIL_PROC_TYPES = new Set([70, 73, 74, 75, 198, 203]);

export function isRetailProc(procType: number): boolean {
  return RETAIL_PROC_TYPES.has(procType);
}

export function procTypeLabel(procType: number): string {
  return PROC_TYPE_LABELS[procType] ?? `不明(${procType})`;
}
