/**
 * 交通行動データ収集基盤（最小版）の Worker 入口。
 *
 * Phase 1 の範囲: iPhone は使わず、mock HEX の投入から Web UI 表示まで
 * end-to-end で完結させる。iOS からの実読取は同じ POST /v1/ingest を叩くだけ。
 */

import { Hono } from "hono";
import { PARSER_VERSION } from "./parser";
import { deriveAll, deriveCard } from "./derive";
import { linkCard, storeSession, validateIngest } from "./ingest";
import { listTransactions, parserStatus } from "./queries";
import type { TransactionView } from "./queries";
import { INDEX_HTML } from "./ui";

export interface Env {
  DB: D1Database;
  /** `wrangler secret put API_TOKEN` で設定する Bearer トークン */
  API_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

/** 認証。/v1/health と UI 以外はすべてトークン必須 */
app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") return next();

  const expected = c.env.API_TOKEN;
  if (!expected) {
    return c.json({ error: "server_misconfigured", detail: "API_TOKEN is not set" }, 500);
  }
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(token, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.get("/v1/health", (c) => c.json({ ok: true, parser_version: PARSER_VERSION }));

// ---------------------------------------------------------------------------
// 受信
// ---------------------------------------------------------------------------

/**
 * POST /v1/ingest
 * 1回の読取セッションを丸ごと受け取る。生HEXは全件保存し、そのあとで
 * そのカードの derived を作り直す（derived の失敗は受信の失敗にしない）。
 */
app.post("/v1/ingest", async (c) => {
  const body = await c.req.json().catch(() => null);
  const validated = validateIngest(body);
  if (!validated.ok) {
    return c.json({ error: "invalid_payload", detail: validated.error }, 400);
  }
  const payload = validated.value;
  const receivedAt = nowIso();

  const stored = await storeSession(c.env.DB, payload, receivedAt);
  if (stored.status === "session_id_conflict") {
    return c.json(
      {
        error: "session_id_conflict",
        detail: "この session_id は別の card_pseudonym で受信済みです",
      },
      409,
    );
  }

  let link: { linked: boolean; conflict_with?: string } | null = null;
  if (payload.participantId) {
    const result = await linkCard(
      c.env.DB,
      payload.participantId,
      payload.cardPseudonym,
      payload.deviceId,
      receivedAt,
    );
    link = result.conflictWith
      ? { linked: false, conflict_with: result.conflictWith }
      : { linked: result.linked };
  }

  // 再送（duplicate_session）でも derived を作り直しておく。raw が唯一の
  // 入力なので何度やっても同じ結果になり、取りこぼしの回復にもなる。
  const derived = await deriveCard(c.env.DB, payload.cardPseudonym, nowIso());

  return c.json({
    status: stored.status,
    session_id: payload.sessionId,
    card_pseudonym: payload.cardPseudonym,
    stored_blocks: stored.storedBlocks,
    rejected_blocks: payload.rejected,
    participant_link: link,
    derived,
  });
});

// ---------------------------------------------------------------------------
// 被験者・カード
// ---------------------------------------------------------------------------

app.get("/v1/participants", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.participant_id, p.label, p.created_at,
            COUNT(pc.card_pseudonym) AS card_count
       FROM participants p
       LEFT JOIN participant_cards pc ON pc.participant_id = p.participant_id
      GROUP BY p.participant_id
      ORDER BY p.created_at`,
  ).all();
  return c.json({ participants: results });
});

app.post("/v1/participants", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { participant_id?: unknown; label?: unknown }
    | null;
  const id = typeof body?.participant_id === "string" ? body.participant_id : null;
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return c.json({ error: "invalid_payload", detail: "participant_id is required" }, 400);
  }
  const label = typeof body?.label === "string" ? body.label : null;
  await c.env.DB.prepare(
    `INSERT INTO participants (participant_id, label, created_at) VALUES (?, ?, ?)
       ON CONFLICT(participant_id) DO UPDATE SET label = excluded.label`,
  )
    .bind(id, label, nowIso())
    .run();
  return c.json({ participant_id: id, label });
});

/** カード仮名を被験者に紐付ける。1被験者に複数仮名がぶら下がるのが正常系 */
app.post("/v1/participants/:participantId/cards", async (c) => {
  const participantId = c.req.param("participantId");
  const body = (await c.req.json().catch(() => null)) as
    | { card_pseudonym?: unknown; device_id?: unknown; note?: unknown }
    | null;
  const cardPseudonym = typeof body?.card_pseudonym === "string" ? body.card_pseudonym : null;
  if (!cardPseudonym) {
    return c.json({ error: "invalid_payload", detail: "card_pseudonym is required" }, 400);
  }
  const result = await linkCard(
    c.env.DB,
    participantId,
    cardPseudonym,
    typeof body?.device_id === "string" ? body.device_id : null,
    nowIso(),
    typeof body?.note === "string" ? body.note : null,
  );
  if (!result.linked) {
    return c.json(
      {
        error: "card_already_linked",
        detail: `この仮名は ${result.conflictWith} に紐付いています`,
      },
      409,
    );
  }
  return c.json({ participant_id: participantId, card_pseudonym: cardPseudonym, linked: true });
});

/** 観測済みのカード仮名一覧（未割当を含む） */
app.get("/v1/cards", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.card_pseudonym,
            pc.participant_id,
            pc.first_seen_at,
            pc.note,
            COUNT(DISTINCT s.session_id) AS session_count,
            MIN(s.received_at) AS first_received_at,
            MAX(s.received_at) AS last_received_at,
            (SELECT COUNT(*) FROM derived_transactions d
              WHERE d.card_pseudonym = s.card_pseudonym) AS transaction_count
       FROM read_sessions s
       LEFT JOIN participant_cards pc ON pc.card_pseudonym = s.card_pseudonym
      GROUP BY s.card_pseudonym
      ORDER BY last_received_at DESC`,
  ).all();
  return c.json({ cards: results });
});

// ---------------------------------------------------------------------------
// 受信した事実の参照（生データ）
// ---------------------------------------------------------------------------

app.get("/v1/sessions", async (c) => {
  const card = c.req.query("card_pseudonym");
  const limit = clampInt(c.req.query("limit"), 100, 1, 1000);
  const sql = `
    SELECT s.session_id, s.card_pseudonym, pc.participant_id, s.device_id,
           s.read_at, s.received_at, s.record_count, s.client_version,
           (SELECT COUNT(*) FROM raw_observations r WHERE r.session_id = s.session_id) AS raw_count
      FROM read_sessions s
      LEFT JOIN participant_cards pc ON pc.card_pseudonym = s.card_pseudonym
     ${card ? "WHERE s.card_pseudonym = ?" : ""}
     ORDER BY s.received_at DESC
     LIMIT ?`;
  const stmt = card
    ? c.env.DB.prepare(sql).bind(card, limit)
    : c.env.DB.prepare(sql).bind(limit);
  const { results } = await stmt.all();
  return c.json({ sessions: results });
});

app.get("/v1/sessions/:sessionId/raw", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = await c.env.DB.prepare(`SELECT * FROM read_sessions WHERE session_id = ?`)
    .bind(sessionId)
    .first();
  if (!session) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, block_order, raw_hex, received_at
       FROM raw_observations WHERE session_id = ? ORDER BY block_order`,
  )
    .bind(sessionId)
    .all();
  return c.json({ session, raw_observations: results });
});

// ---------------------------------------------------------------------------
// 解釈結果の参照
// ---------------------------------------------------------------------------

app.get("/v1/transactions", async (c) => {
  const { transactions, deduped } = await listTransactions(c.env.DB, readFilter(c.req));
  return c.json({ transactions, deduped, parser_version: PARSER_VERSION });
});

app.get("/v1/transactions.csv", async (c) => {
  const filter = readFilter(c.req);
  const { transactions } = await listTransactions(c.env.DB, { ...filter, limit: 50000, offset: 0 });
  return new Response(toCsv(transactions), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="transactions.csv"',
    },
  });
});

app.get("/v1/parser", async (c) => c.json(await parserStatus(c.env.DB, PARSER_VERSION)));

/**
 * POST /v1/reparse
 * derived_transactions を全消し→ raw から再生成する。
 * parser_version を上げたときに全期間を作り直すための入口であり、
 * この操作で失われる情報がないことがこの設計の要点。
 */
app.post("/v1/reparse", async (c) => {
  const card = c.req.query("card_pseudonym");
  const stats = card
    ? await deriveCard(c.env.DB, card, nowIso())
    : await deriveAll(c.env.DB, nowIso());
  return c.json({ parser_version: PARSER_VERSION, scope: card ?? "all", stats });
});

// ---------------------------------------------------------------------------
// 駅コードマスタ
// ---------------------------------------------------------------------------

app.get("/v1/station-master", async (c) => {
  const limit = clampInt(c.req.query("limit"), 200, 1, 5000);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM station_master ORDER BY area_code, line_code, station_code LIMIT ?`,
  )
    .bind(limit)
    .all();
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM station_master`).first<{ n: number }>();
  return c.json({ total: count?.n ?? 0, stations: results });
});

/**
 * 対応表の投入。JSON 配列 か CSV テキスト（area,line,station,company,line_name,station_name）。
 * 未収載でも UI はコードをそのまま表示するので、部分的な投入で構わない。
 */
app.post("/v1/station-master", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { rows?: unknown; csv?: unknown }
    | null;

  let rows: string[][] = [];
  if (typeof body?.csv === "string") {
    rows = body.csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split(",").map((cell) => cell.trim()));
  } else if (Array.isArray(body?.rows)) {
    rows = (body.rows as Record<string, string>[]).map((r) => [
      r.area_code ?? "",
      r.line_code ?? "",
      r.station_code ?? "",
      r.company_name ?? "",
      r.line_name ?? "",
      r.station_name ?? "",
    ]);
  } else {
    return c.json({ error: "invalid_payload", detail: "rows[] or csv is required" }, 400);
  }

  const statements: D1PreparedStatement[] = [];
  const rejected: number[] = [];
  rows.forEach((cells, index) => {
    const [area, line, station, company, lineName, stationName] = cells;
    if (!area || !line || !station) {
      rejected.push(index);
      return;
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO station_master
           (area_code, line_code, station_code, company_name, line_name, station_name)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(area_code, line_code, station_code) DO UPDATE SET
           company_name = excluded.company_name,
           line_name    = excluded.line_name,
           station_name = excluded.station_name`,
      ).bind(
        area.toUpperCase(),
        line.toUpperCase(),
        station.toUpperCase(),
        company || null,
        lineName || null,
        stationName || null,
      ),
    );
  });

  for (let i = 0; i < statements.length; i += 50) {
    await c.env.DB.batch(statements.slice(i, i + 50));
  }
  return c.json({ upserted: statements.length, rejected_rows: rejected });
});

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

app.get("/", (c) => c.html(INDEX_HTML));

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error", detail: String(err) }, 500);
});

export default app;

// ---------------------------------------------------------------------------

interface QueryReader {
  query(key: string): string | undefined;
}

function readFilter(req: QueryReader) {
  return {
    participantId: req.query("participant_id") || undefined,
    cardPseudonym: req.query("card_pseudonym") || undefined,
    from: req.query("from") || undefined,
    to: req.query("to") || undefined,
    limit: clampInt(req.query("limit"), 200, 1, 5000),
    offset: clampInt(req.query("offset"), 0, 0, 1_000_000),
  };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const CSV_COLUMNS = [
  "used_date",
  "participant_id",
  "card_pseudonym",
  "proc_type",
  "proc_type_label",
  "entry_station_code",
  "entry_label",
  "exit_station_code",
  "exit_label",
  "balance",
  "amount_estimated",
  "source_raw_hex",
  "first_session_id",
  "parser_version",
] as const;

function toCsv(rows: TransactionView[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      CSV_COLUMNS.map((col) => csvCell((row as unknown as Record<string, unknown>)[col])).join(","),
    );
  }
  // Excel 対策の BOM 付き
  return `﻿${lines.join("\r\n")}\r\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** トークン比較。長さの違いで早期に返さないようにする */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
