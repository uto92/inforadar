/// webapp（WESTER来場チェックイン）の同期エンドポイント。
///
/// 0001 の /v1/scans は iOS アプリ用で生の12桁を保存するが、webapp は
/// 「会員IDの生値を保存しない」方針のためテーブルもエンドポイントも分ける。
/// ここで受け取るのはイベントごとのソルト付き SHA-256 ハッシュ（64桁hex）のみ。

export interface SyncEnv {
  DB: D1Database;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH_RE = /^[0-9a-f]{64}$/;
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

interface CleanPlace {
  id: string;
  name: string;
  self_enabled: 0 | 1;
  device_id: string;
  created_at: string;
}

interface CleanCheckin {
  id: string;
  event_id: string;
  place_id: string | null;
  member_hash: string | null;
  suffix_hash: string | null;
  method: "scan" | "manual" | "nfc" | "self";
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

export function validatePlace(raw: unknown): CleanPlace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
  if (!UUID_RE.test(id)) return null;
  const name = str(r.name, 200);
  const deviceId = str(r.deviceId, 64);
  if (!name || !deviceId) return null;
  if (!isIso(r.createdAt)) return null;
  return {
    id,
    name,
    self_enabled: r.selfEnabled === 1 || r.selfEnabled === true ? 1 : 0,
    device_id: deviceId,
    created_at: r.createdAt,
  };
}

/**
 * チェックインの検証。
 *
 * ここは「保存してよい項目」のホワイトリストでもある。
 * 未知のフィールド（例: NFCプローブが送りうる交通系ICの利用履歴 `records`）は
 * 読み取らないため、D1に入る余地が構造的に無い。
 * 来場記録の目的に対して過剰な情報を持たないための境界。
 */
export function validateCheckin(raw: unknown): CleanCheckin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
  const eventId = typeof r.eventId === "string" ? r.eventId.toLowerCase() : "";
  if (!UUID_RE.test(id) || !UUID_RE.test(eventId)) return null;
  const method =
    r.method === "scan" || r.method === "manual" || r.method === "nfc" || r.method === "self"
      ? r.method
      : null;
  if (!method) return null;
  // 場所は任意。指定される場合はUUID
  const placeIdRaw = typeof r.placeId === "string" ? r.placeId.toLowerCase() : "";
  const placeId = UUID_RE.test(placeIdRaw) ? placeIdRaw : null;
  const suffixHash = optionalHash(r.suffixHash);
  // scan / manual は末尾6桁の照合キーを伴う。
  // nfc / self には相当する概念が無いため suffix_hash は持たない
  if ((method === "scan" || method === "manual") && !suffixHash) return null;
  // manual 以外は必ず本体ハッシュ（またはランダム仮名）を伴う
  const memberHash = optionalHash(r.memberHash);
  if (method !== "manual" && !memberHash) return null;
  if (!isIso(r.checkedInAt)) return null;
  const deviceId = str(r.deviceId, 64);
  if (!deviceId) return null;
  return {
    id,
    event_id: eventId,
    place_id: placeId,
    member_hash: method === "manual" ? null : memberHash,
    suffix_hash: method === "scan" || method === "manual" ? suffixHash : null,
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
  const places = Array.isArray(b.places) ? b.places : [];
  const checkins = Array.isArray(b.checkins) ? b.checkins : [];
  const scanErrors = Array.isArray(b.scanErrors) ? b.scanErrors : [];
  if (
    events.length > MAX_ROWS_PER_KIND ||
    places.length > MAX_ROWS_PER_KIND ||
    checkins.length > MAX_ROWS_PER_KIND ||
    scanErrors.length > MAX_ROWS_PER_KIND
  ) {
    return json({ error: `too many rows (max ${MAX_ROWS_PER_KIND} per kind)` }, 413);
  }

  const validEvents = events.map(validateEvent).filter((v): v is CleanEvent => v !== null);
  const validPlaces = places.map(validatePlace).filter((v): v is CleanPlace => v !== null);
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
  if (validPlaces.length > 0) {
    // 場所は name / self_enabled の後からの変更を反映する必要があるため
    // 単純な IGNORE ではなく upsert（最後の書き込みが勝つ）
    const stmt = env.DB.prepare(
      "INSERT INTO wc_places (id, name, self_enabled, device_id, created_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5)" +
        " ON CONFLICT(id) DO UPDATE SET name = excluded.name, self_enabled = excluded.self_enabled," +
        // 更新を増分取得(since)に乗せるため、受信時刻も進める
        " received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    );
    for (const pl of validPlaces) {
      statements.push(stmt.bind(pl.id, pl.name, pl.self_enabled, pl.device_id, pl.created_at));
    }
  }
  if (validCheckins.length > 0) {
    // id の重複（再送）に加え、event_id+member_hash のユニーク制約により
    // 別端末が同じ来場者を読み取った場合も後着が無視される
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO wc_checkins" +
        " (id, event_id, place_id, member_hash, suffix_hash, method, checked_in_at, device_id)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    );
    for (const c of validCheckins) {
      statements.push(
        stmt.bind(
          c.id,
          c.event_id,
          c.place_id,
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
  let stored = { events: 0, places: 0, checkins: 0, scanErrors: 0 };
  if (statements.length > 0) {
    const results = await env.DB.batch(statements);
    const sum = (from: number, count: number) =>
      results.slice(from, from + count).reduce((acc, r) => acc + (r.meta?.changes ?? 0), 0);
    // バッチの並び: events → places → checkins → scanErrors
    const plStart = validEvents.length;
    const ckStart = plStart + validPlaces.length;
    const seStart = ckStart + validCheckins.length;
    stored = {
      events: sum(0, validEvents.length),
      places: sum(plStart, validPlaces.length),
      checkins: sum(ckStart, validCheckins.length),
      scanErrors: sum(seStart, validErrors.length),
    };
  }

  return json({
    // 実際に登録された数（places は upsert のため更新も含む）
    stored,
    // 検証は通ったが既存だったため無視された数（再送・端末間の重複）
    ignored: {
      events: validEvents.length - stored.events,
      places: validPlaces.length - stored.places,
      checkins: validCheckins.length - stored.checkins,
      scanErrors: validErrors.length - stored.scanErrors,
    },
    // 形式不正で破棄した数
    rejected: {
      events: events.length - validEvents.length,
      places: places.length - validPlaces.length,
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

  const [events, places, checkins, scanErrors] = await Promise.all([
    bind(
      "SELECT id, name, event_date, venue, device_id, created_at, received_at FROM wc_events" +
        ` WHERE received_at > ?1${evWhere} ORDER BY received_at LIMIT ${PULL_LIMIT}`
    ).all<Record<string, string>>(),
    // 場所はプロジェクト全体で共有のため eventId では絞らない
    env.DB
      .prepare(
        "SELECT id, name, self_enabled, device_id, created_at, received_at FROM wc_places" +
          ` WHERE received_at > ?1 ORDER BY received_at LIMIT ${PULL_LIMIT}`
      )
      .bind(cursor)
      .all<Record<string, string | number | null>>(),
    bind(
      "SELECT id, event_id, place_id, member_hash, suffix_hash, method, checked_in_at, device_id, received_at" +
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
    ...places.results.map((r) => r.received_at),
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
    places: places.results.map((r) => ({
      id: r.id,
      name: r.name,
      selfEnabled: r.self_enabled === 1 ? 1 : 0,
      deviceId: r.device_id,
      createdAt: r.created_at,
    })),
    checkins: checkins.results.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      placeId: r.place_id,
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
      places.results.length === PULL_LIMIT ||
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
