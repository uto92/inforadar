/**
 * 参照系クエリ。derived_transactions に station_master と participant_cards を
 * 突き合わせて返す。未収載の駅コードは名前を付けず、コードのまま返す
 * （UI 側でコードをそのまま表示する）。
 */

import { procTypeLabel } from "./parser";

export interface TransactionFilter {
  participantId?: string;
  cardPseudonym?: string;
  /** YYYY-MM-DD */
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

interface TransactionRow {
  transaction_key: string;
  card_pseudonym: string;
  participant_id: string | null;
  used_date: string | null;
  proc_type: number | null;
  entry_station_code: string | null;
  exit_station_code: string | null;
  balance: number | null;
  amount_estimated: number | null;
  source_raw_hex: string;
  first_session_id: string;
  parser_version: string;
  derived_at: string;
  entry_company_name: string | null;
  entry_line_name: string | null;
  entry_station_name: string | null;
  exit_company_name: string | null;
  exit_line_name: string | null;
  exit_station_name: string | null;
}

export interface TransactionView extends TransactionRow {
  proc_type_label: string;
  entry_label: string | null;
  exit_label: string | null;
  /** 同一取引が他のカード仮名でも観測されている場合、その仮名 */
  also_seen_as: string[];
}

/**
 * 駅コードは "AA-LL-SS" の1列に持っているため、station_master とは
 * substr で突き合わせる（PK (area, line, station) のインデックスが効く）。
 */
const STATION_JOIN = (alias: string, column: string) => `
  LEFT JOIN station_master ${alias}
         ON ${alias}.area_code    = substr(d.${column}, 1, 2)
        AND ${alias}.line_code    = substr(d.${column}, 4, 2)
        AND ${alias}.station_code = substr(d.${column}, 7, 2)`;

export async function listTransactions(
  db: D1Database,
  filter: TransactionFilter,
): Promise<{ transactions: TransactionView[]; deduped: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filter.participantId) {
    where.push("pc.participant_id = ?");
    binds.push(filter.participantId);
  }
  if (filter.cardPseudonym) {
    where.push("d.card_pseudonym = ?");
    binds.push(filter.cardPseudonym);
  }
  if (filter.from) {
    where.push("d.used_date >= ?");
    binds.push(filter.from);
  }
  if (filter.to) {
    where.push("d.used_date <= ?");
    binds.push(filter.to);
  }

  // 同日内の順序は連番で決まる。連番は生HEXの13〜15バイト目（1-indexed の
  // 25文字目から6文字）なので、固定長HEXの辞書順 = 数値順を利用して並べる。
  const sql = `
    SELECT d.transaction_key, d.card_pseudonym, pc.participant_id,
           d.used_date, d.proc_type, d.entry_station_code, d.exit_station_code,
           d.balance, d.amount_estimated, d.source_raw_hex, d.first_session_id,
           d.parser_version, d.derived_at,
           ent.company_name AS entry_company_name,
           ent.line_name    AS entry_line_name,
           ent.station_name AS entry_station_name,
           ext.company_name AS exit_company_name,
           ext.line_name    AS exit_line_name,
           ext.station_name AS exit_station_name
      FROM derived_transactions d
      LEFT JOIN participant_cards pc ON pc.card_pseudonym = d.card_pseudonym
      ${STATION_JOIN("ent", "entry_station_code")}
      ${STATION_JOIN("ext", "exit_station_code")}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY d.used_date DESC, substr(d.source_raw_hex, 25, 6) DESC
     LIMIT ? OFFSET ?`;

  const { results } = await db
    .prepare(sql)
    .bind(...binds, filter.limit, filter.offset)
    .all<TransactionRow>();

  const rows = results.map(toView);

  // 被験者単位で見るときは、同一実カードが複数仮名で観測されている可能性がある。
  // 生HEXが同一なら同じ取引なので1件に畳み、どの仮名でも見えたかを添える。
  if (!filter.participantId) {
    return { transactions: rows, deduped: 0 };
  }
  const byHex = new Map<string, TransactionView>();
  let deduped = 0;
  for (const row of rows) {
    const seen = byHex.get(row.source_raw_hex);
    if (seen) {
      seen.also_seen_as.push(row.card_pseudonym);
      deduped += 1;
      continue;
    }
    byHex.set(row.source_raw_hex, row);
  }
  return { transactions: [...byHex.values()], deduped };
}

function toView(row: TransactionRow): TransactionView {
  return {
    ...row,
    proc_type_label: row.proc_type === null ? "不明" : procTypeLabel(row.proc_type),
    entry_label: stationLabel(row.entry_station_code, row.entry_station_name, row.entry_line_name),
    exit_label: stationLabel(row.exit_station_code, row.exit_station_name, row.exit_line_name),
    also_seen_as: [],
  };
}

/** マスタ未収載ならコードをそのまま返す（推測で名前を作らない） */
function stationLabel(
  code: string | null,
  stationName: string | null,
  lineName: string | null,
): string | null {
  if (!code) return null;
  if (!stationName) return code;
  return lineName ? `${lineName} ${stationName}` : stationName;
}

export interface ParserStatus {
  current_parser_version: string;
  derived_total: number;
  by_parser_version: { parser_version: string; count: number }[];
  /** 現行パーサ以外で作られた行数。0 でなければ再解析が必要 */
  stale: number;
  raw_observations: number;
  read_sessions: number;
}

export async function parserStatus(db: D1Database, currentVersion: string): Promise<ParserStatus> {
  const [byVersion, counts] = await Promise.all([
    db
      .prepare(
        `SELECT parser_version, COUNT(*) AS count
           FROM derived_transactions GROUP BY parser_version ORDER BY parser_version`,
      )
      .all<{ parser_version: string; count: number }>(),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM raw_observations)     AS raw_observations,
           (SELECT COUNT(*) FROM read_sessions)        AS read_sessions,
           (SELECT COUNT(*) FROM derived_transactions) AS derived_total`,
      )
      .first<{ raw_observations: number; read_sessions: number; derived_total: number }>(),
  ]);

  const rows = byVersion.results;
  return {
    current_parser_version: currentVersion,
    derived_total: counts?.derived_total ?? 0,
    by_parser_version: rows,
    stale: rows
      .filter((r) => r.parser_version !== currentVersion)
      .reduce((sum, r) => sum + r.count, 0),
    raw_observations: counts?.raw_observations ?? 0,
    read_sessions: counts?.read_sessions ?? 0,
  };
}
