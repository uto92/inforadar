/**
 * 解釈レイヤ（raw_observations → derived_transactions）。
 *
 * 大原則: derived_transactions は「いつでも全消し→再生成できる」ものとして扱う。
 * したがってこのファイルの関数はすべて冪等で、対象カードの derived を一度
 * 削除してから raw だけを入力に再構築する。raw を書き換えることは決してしない。
 */

import { PARSER_VERSION, parseHistoryBlock } from "./parser";
import type { ParsedTransaction } from "./parser";

export interface DeriveStats {
  /** 対象になったカード仮名の数 */
  cards: number;
  /** 走査した生レコード行数（重複を含む、届いたままの数） */
  rawRows: number;
  /** 内容が異なる生ブロック数（重複除去後） */
  uniqueBlocks: number;
  /** derived_transactions に書き込んだ件数 */
  derived: number;
  /** 未使用ブロック（全0）として読み飛ばした件数 */
  blank: number;
  /** 解釈できず読み飛ばした件数 */
  unparsable: number;
}

function emptyStats(): DeriveStats {
  return {
    cards: 0,
    rawRows: 0,
    uniqueBlocks: 0,
    derived: 0,
    blank: 0,
    unparsable: 0,
  };
}

function mergeStats(a: DeriveStats, b: DeriveStats): DeriveStats {
  return {
    cards: a.cards + b.cards,
    rawRows: a.rawRows + b.rawRows,
    uniqueBlocks: a.uniqueBlocks + b.uniqueBlocks,
    derived: a.derived + b.derived,
    blank: a.blank + b.blank,
    unparsable: a.unparsable + b.unparsable,
  };
}

/**
 * transaction_key の生成規則: `{card_pseudonym}:{raw_hex}`
 *
 * 生HEXそのものを鍵に使う。理由:
 *   - 同じ取引を何度読み取っても内容が同じなので自然に1行へ畳まれる
 *     （raw 側は全件残っているので「何回届いたか」は失われない）
 *   - 連番だけを鍵にすると、カード再発行で連番が巻き戻ったときに
 *     別の取引を上書きしてしまう
 *   - ハッシュを使わないので、鍵から生データを目視で追える
 * card_pseudonym を前置しているのは、同一ブロックが別カード仮名として
 * 届いた場合（アプリ再インストール後の同一実カード）を潰さないため。
 */
export function transactionKey(cardPseudonym: string, rawHex: string): string {
  return `${cardPseudonym}:${rawHex}`;
}

interface RawRow {
  raw_hex: string;
  session_id: string;
}

interface DerivedRow {
  transactionKey: string;
  parsed: ParsedTransaction;
  rawHex: string;
  firstSessionId: string;
  amountEstimated: number | null;
}

/**
 * 1カード仮名ぶんの derived を作り直す。
 * @param now ISO8601（derived_at に入る）
 */
export async function deriveCard(
  db: D1Database,
  cardPseudonym: string,
  now: string,
): Promise<DeriveStats> {
  const stats = emptyStats();
  stats.cards = 1;

  // 受信が早い順に走査する。これにより「その生HEXを最初に運んできた
  // セッション」が first_session_id になり、再生成しても値がぶれない。
  const { results } = await db
    .prepare(
      `SELECT r.raw_hex AS raw_hex, r.session_id AS session_id
         FROM raw_observations r
         JOIN read_sessions s ON s.session_id = r.session_id
        WHERE s.card_pseudonym = ?
        ORDER BY r.received_at ASC, r.id ASC`,
    )
    .bind(cardPseudonym)
    .all<RawRow>();

  stats.rawRows = results.length;

  const firstSessionByHex = new Map<string, string>();
  for (const row of results) {
    if (!firstSessionByHex.has(row.raw_hex)) {
      firstSessionByHex.set(row.raw_hex, row.session_id);
    }
  }
  stats.uniqueBlocks = firstSessionByHex.size;

  const parsed: { parsed: ParsedTransaction; rawHex: string; firstSessionId: string }[] = [];
  for (const [rawHex, sessionId] of firstSessionByHex) {
    const result = parseHistoryBlock(rawHex);
    if (result.kind === "blank") {
      stats.blank += 1;
      continue;
    }
    if (result.kind === "unparsable") {
      stats.unparsable += 1;
      continue;
    }
    parsed.push({ parsed: result.value, rawHex, firstSessionId: sessionId });
  }

  // 連番（24bit）が同一カード内の取引順序。日付は同日内の順序を決められない
  // ので、連番を主キーに、欠損時のみ日付で補助的に並べる。
  parsed.sort((a, b) => {
    if (a.parsed.seq !== b.parsed.seq) return a.parsed.seq - b.parsed.seq;
    return (a.parsed.usedDate ?? "").localeCompare(b.parsed.usedDate ?? "");
  });

  const rows: DerivedRow[] = parsed.map((entry, index) => ({
    transactionKey: transactionKey(cardPseudonym, entry.rawHex),
    parsed: entry.parsed,
    rawHex: entry.rawHex,
    firstSessionId: entry.firstSessionId,
    amountEstimated: estimateAmount(parsed[index - 1]?.parsed, entry.parsed),
  }));

  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM derived_transactions WHERE card_pseudonym = ?`).bind(cardPseudonym),
  ];
  for (const row of rows) {
    statements.push(
      db
        .prepare(
          `INSERT INTO derived_transactions (
             transaction_key, card_pseudonym, used_date, proc_type,
             entry_station_code, exit_station_code, balance, amount_estimated,
             source_raw_hex, first_session_id, parser_version, derived_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.transactionKey,
          cardPseudonym,
          row.parsed.usedDate,
          row.parsed.procType,
          row.parsed.entryStationCode,
          row.parsed.exitStationCode,
          row.parsed.balance,
          row.amountEstimated,
          row.rawHex,
          row.firstSessionId,
          PARSER_VERSION,
          now,
        ),
    );
  }

  // D1 の1バッチあたりの上限に触れないよう分割する。
  // DELETE を含む先頭チャンクから順に実行するので、途中失敗しても
  // 「消えただけ」で終わり、再実行すれば raw から必ず作り直せる。
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }

  stats.derived = rows.length;
  return stats;
}

/**
 * 直前レコードとの残額差分（推定値）。正なら減少（支払）、負なら増加（チャージ）。
 *
 * 連番が連続していないときは null を返す。間に取得できていない取引が
 * あるかもしれず、その差分は「2件以上の合算」になってしまうため。
 * 推定値であることをスキーマ名（amount_estimated）と併せて明示している。
 */
export function estimateAmount(
  prev: ParsedTransaction | undefined,
  current: ParsedTransaction,
): number | null {
  if (!prev) return null;
  if (current.seq - prev.seq !== 1) return null;
  return prev.balance - current.balance;
}

/**
 * 全カードぶんの derived を作り直す（parser_version を上げたときの再解析）。
 * raw_observations は一切触らない。
 */
export async function deriveAll(db: D1Database, now: string): Promise<DeriveStats> {
  const { results } = await db
    .prepare(`SELECT DISTINCT card_pseudonym FROM read_sessions ORDER BY card_pseudonym`)
    .all<{ card_pseudonym: string }>();

  // 生データが消えたカード（= もう存在しないはずだが念のため）の残骸を落とす
  await db.prepare(`DELETE FROM derived_transactions WHERE card_pseudonym NOT IN
                      (SELECT card_pseudonym FROM read_sessions)`).run();

  let stats = emptyStats();
  for (const row of results) {
    stats = mergeStats(stats, await deriveCard(db, row.card_pseudonym, now));
  }
  return stats;
}
