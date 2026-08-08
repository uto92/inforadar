/// 会員IDの仮名化。生値はここを通過した後は保持しない。
/// 注意: 12桁数値空間のためソルトが漏れると全探索可能（仮名化であり匿名化ではない）。

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 保存・重複判定・CSVに使う本体ハッシュ */
export function memberHash(salt: string, memberId: string): Promise<string> {
  return sha256Hex(`${salt}:${memberId}`);
}

/** 手入力フォールバック照合用: 末尾桁のハッシュ（スキャン記録にも常に併存させる） */
export function suffixHash(salt: string, suffixDigits: string): Promise<string> {
  return sha256Hex(`${salt}:sfx:${suffixDigits}`);
}

/** イベント作成時に生成するソルト（乱数16byte hex） */
export function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
