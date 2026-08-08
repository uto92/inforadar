/// webapp（WESTER来場チェックイン）の同期エンドポイント。
///
/// 0001 の /v1/scans は iOS アプリ用で生の12桁を保存するが、webapp は
/// 「会員IDの生値を保存しない」方針のためテーブルもエンドポイントも分ける。
/// ここで受け取るのはイベントごとのソルト付き SHA-256 ハッシュ（64桁hex）のみ。

export interface SyncEnv {
  DB: D1Database;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS_PER_KIND = 1000;
/** 1回の取得で返す最大件数。これを超える場合は since を進めて再取得する */
const PULL_LIMIT = 2000;

interface CleanEvent {
  id: string;
  name: string;
  event_date: string;
  venue: string;
  device_id: string;
  created_at: string;
}

interface CleanCheckin {
  id: string;
  event_id: string;
  member_hash: string | null;
  suffix_hash: string;
  method: "scan" | "manual";
  checked_in_at: string;
  device_id: string;
}

interface CleanScanError {
  id: string;
  event_id: string;
  kind: "duplicate" | "invalid_format";
  member_hash: string | null;
  suffix_hash: string | null;
  symbology: string | null;
  occurred_at: string;
  device_id: string;
}

// ---------------------------------------------------------------- 検証

function str(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function optionalHash(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return HASH_RE.test(value) ? value.toLowerCase() : null;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 40;
}

export function validateEvent(raw: unknown): CleanEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
  if (!UUID_RE.test(id)) return null;
  const name = str(r.name, 200);
  const venue = str(r.venue, 200);
  const deviceId = str(r.deviceId, 64);
  const eventDate = typeof r.eventDate === "string" ? r.eventDate : "";
  if (!name || !venue || !deviceId) return null;
  if (!DATE_ONLY_RE.test(eventDate)) return null;
  if (!isIso(r.createdAt)) return null;
  return {
    id,
    name,
    event_date: eventDate,
    venue,
    device_id: deviceId,
    created_at: r.createdAt,
  };
}

export function validateCheckin(raw: unknown): CleanCheckin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
  const eventId = typeof r.eventId === "string" ? r.eventId.toLowerCase() : "";
  if (!UUID_RE.test(id) || !UUID_RE.test(eventId)) return null;
  const method = r.method === "scan" || r.method === "manual" ? r.method : null;
  if (!method) return null;
  const suffixHash = optionalHash(r.suffixHash);
  if (!suffixHash) return null;
  // scan は必ず memberHash を伴う。生値や短い文字列が来た場合は弾く
  const memberHash = optionalHash(r.memberHash);
  if (method === "scan" && !memberHash) return null;
  if (!isIso(r.checkedInAt)) return null;
  const deviceId = str(r.deviceId, 64);
  if (!deviceId) return null;
  return {
    id,
    event_id: eventId,
    member_hash: method === "scan" ? memberHash : null,
    suffix_hash: suffixHash,
    method,
    checked_in_at: r.checkedInAt,
    device_id: deviceId,
  };
}

export function validateScanError(raw: unknown): CleanScanError | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
  const eventId = typeof r.eventId === "string" ? r.eventId.toLowerCase() : "";
  if (!UUID_RE.test(id) || !UUID_RE.test(eventId)) return null;
  const kind = r.kind === "duplicate" || r.kind === "invalid_format" ? r.kind : null;
  if (!kind) return null;
  if (!isIso(r.occurredAt)) return null;
  const deviceId = str(r.deviceId, 64);
  if (!deviceId) return null;
  return {
    id,
    event_id: eventId,
    kind,
    member_hash: optionalHash(r.memberHash),
    suffix_hash: optionalHash(r.suffixHash),
    symbology: typeof r.symbology === "string" ? r.symbology.slice(0, 40) : null,
    occurred_at: r.occurredAt,
    device_id: deviceId,
  };
}

// ------------------------------------------- POST /v1/wc/sync（冪等な取り込み）

export async function handlePush(request: Request, env: SyncEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const events = Array.isArray(b.events) ? b.events : [];
  const checkins = Array.isArray(b.checkins) ? b.checkins : [];
  const scanErrors = Array.isArray(b.scanErrors) ? b.scanErrors : [];
  if (
    events.length > MAX_ROWS_PER_KIND ||
    checkins.length > MAX_ROWS_PER_KIND ||
    scanErrors.length > MAX_ROWS_PER_KIND
  ) {
    return json({ error: `too many rows (max ${MAX_ROWS_PER_KIND} per kind)` }, 413);
  }

  const validEvents = events.map(validateEvent).filter((v): v is CleanEvent => v !== null);
  const validCheckins = checkins.map(validateCheckin).filter((v): v is CleanCheckin => v !== null);
  const validErrors = scanErrors
    .map(validateScanError)
    .filter((v): v is CleanScanError => v !== null);

  const statements: D1PreparedStatement[] = [];
  if (validEvents.length > 0) {
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO wc_events (id, name, event_date, venue, device_id, created_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    );
    for (const e of validEvents) {
      statements.push(
        stmt.bind(e.id, e.name, e.event_date, e.venue, e.device_id, e.created_at)
      );
    }
  }
  if (validCheckins.length > 0) {
    // id の重複（再送）に加え、event_id+member_hash のユニーク制約により
    // 別端末が同じ来場者を読み取った場合も後着が無視される
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO wc_checkins" +
        " (id, event_id, member_hash, suffix_hash, method, checked_in_at, device_id)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    );
    for (const c of validCheckins) {
      statements.push(
        stmt.bind(
          c.id,
          c.event_id,
          c.member_hash,
          c.suffix_hash,
          c.method,
          c.checked_in_at,
          c.device_id
        )
      );
    }
  }
  if (validErrors.length > 0) {
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO wc_scan_errors" +
        " (id, event_id, kind, member_hash, suffix_hash, symbology, occurred_at, device_id)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    );
    for (const e of validErrors) {
      statements.push(
        stmt.bind(
          e.id,
          e.event_id,
          e.kind,
          e.member_hash,
          e.suffix_hash,
          e.symbology,
          e.occurred_at,
          e.device_id
        )
      );
    }
  }
  // INSERT OR IGNORE は重複を黙って捨てるため、検証を通った数ではなく
  // 実際に登録された数(meta.changes)を返す。そうしないと
  // 「別端末が既に記録済みだったので無視された」ことが呼び出し側に伝わらない
  let stored = { events: 0, checkins: 0, scanErrors: 0 };
  if (statements.length > 0) {
    const results = await env.DB.batch(statements);
    const sum = (from: number, count: number) =>
      results.slice(from, from + count).reduce((acc, r) => acc + (r.meta?.changes ?? 0), 0);
    const evEnd = validEvents.length;
    const ckEnd = evEnd + validCheckins.length;
    stored = {
      events: sum(0, validEvents.length),
      checkins: sum(evEnd, validCheckins.length),
      scanErrors: sum(ckEnd, validErrors.length),
    };
  }

  return json({
    // 実際に登録された数
    stored,
    // 検証は通ったが既存だったため無視された数（再送・端末間の重複）
    ignored: {
      events: validEvents.length - stored.events,
      checkins: validCheckins.length - stored.checkins,
      scanErrors: validErrors.length - stored.scanErrors,
    },
    // 形式不正で破棄した数
    rejected: {
      events: events.length - validEvents.length,
      checkins: checkins.length - validCheckins.length,
      scanErrors: scanErrors.length - validErrors.length,
    },
  });
}

// ------------------------------- GET /v1/wc/sync?since=（他端末ぶんの取得）

export async function handlePull(url: URL, env: SyncEnv): Promise<Response> {
  const since = url.searchParams.get("since") ?? "";
  // received_at はサーバ側の採番なので、端末時計のずれに影響されない
  const cursor = isIso(since) ? since : "1970-01-01T00:00:00.000Z";
  const eventId = url.searchParams.get("eventId");
  if (eventId !== null && !UUID_RE.test(eventId)) {
    return json({ error: "invalid eventId" }, 400);
  }

  const evWhere = eventId ? " AND id = ?2" : "";
  const rowWhere = eventId ? " AND event_id = ?2" : "";
  const bind = (q: string) =>
    eventId ? env.DB.prepare(q).bind(cursor, eventId) : env.DB.prepare(q).bind(cursor);

  const [events, checkins, scanErrors] = await Promise.all([
    bind(
      "SELECT id, name, event_date, venue, device_id, created_at, received_at FROM wc_events" +
        ` WHERE received_at > ?1${evWhere} ORDER BY received_at LIMIT ${PULL_LIMIT}`
    ).all<Record<string, string>>(),
    bind(
      "SELECT id, event_id, member_hash, suffix_hash, method, checked_in_at, device_id, received_at" +
        ` FROM wc_checkins WHERE received_at > ?1${rowWhere} ORDER BY received_at LIMIT ${PULL_LIMIT}`
    ).all<Record<string, string | null>>(),
    bind(
      "SELECT id, event_id, kind, member_hash, suffix_hash, symbology, occurred_at, device_id, received_at" +
        ` FROM wc_scan_errors WHERE received_at > ?1${rowWhere} ORDER BY received_at LIMIT ${PULL_LIMIT}`
    ).all<Record<string, string | null>>(),
  ]);

  // 次回の since。取得した中で最も新しい received_at を使う
  const maxReceived = [
    ...events.results.map((r) => r.received_at),
    ...checkins.results.map((r) => r.received_at),
    ...scanErrors.results.map((r) => r.received_at),
  ].reduce<string>((acc, v) => (typeof v === "string" && v > acc ? v : acc), cursor);

  return json({
    events: events.results.map((r) => ({
      id: r.id,
      name: r.name,
      eventDate: r.event_date,
      venue: r.venue,
      deviceId: r.device_id,
      createdAt: r.created_at,
    })),
    checkins: checkins.results.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      memberHash: r.member_hash,
      suffixHash: r.suffix_hash,
      method: r.method,
      checkedInAt: r.checked_in_at,
      deviceId: r.device_id,
    })),
    scanErrors: scanErrors.results.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      kind: r.kind,
      memberHash: r.member_hash,
      suffixHash: r.suffix_hash,
      symbology: r.symbology,
      occurredAt: r.occurred_at,
      deviceId: r.device_id,
    })),
    nextSince: maxReceived,
    // LIMITに達した場合は続きがある。呼び出し側は nextSince で再取得する
    hasMore:
      events.results.length === PULL_LIMIT ||
      checkins.results.length === PULL_LIMIT ||
      scanErrors.results.length === PULL_LIMIT,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
