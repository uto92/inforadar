import { verifyAccessJwt } from "./accessAuth";
import { handlePull, handlePush } from "./webappSync";

export interface Env {
  DB: D1Database;
  /** `wrangler secret put API_KEY` で設定する Bearer トークン（iOSアプリ用） */
  API_KEY: string;
  /** Cloudflare Access のチームドメイン 例: your-team.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access アプリケーションの Audience (AUD) タグ */
  ACCESS_AUD?: string;
  /**
   * ローカル開発でのみ "1" にする。webapp同期を無認証で通す。
   * 本番では絶対に設定しないこと（.dev.vars にのみ書く）
   */
  DEV_OPEN_WC_SYNC?: string;
  /**
   * webapp同期を許可するオリジン（カンマ区切り）。
   * 例: https://wester-checkin.pages.dev,http://localhost:4180
   * 資格情報付きリクエストのためワイルドカードは使えず、明示指定が必要。
   */
  ALLOWED_ORIGINS?: string;
}

// サーバ側でも会員IDを再検証する（数字ちょうど12桁。違反レコードは破棄）。
// iOS 側の transformID をハッシュ化へ切り替えた場合は、この正規表現も
// 併せて変更すること（例: SHA-256 hex なら /^[0-9a-f]{64}$/）。
const WESTER_ID_RE = /^\d{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECORDS_PER_REQUEST = 1000;

interface CleanRecord {
  uuid: string;
  wester_id: string;
  scanned_at: string;
  event: string | null;
  location: string | null;
  session_id: string | null;
  device_id: string | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/health") {
      return json({ ok: true });
    }
    // webapp（来場チェックイン）の同期。ブラウザは資格情報を持たないため
    // Cloudflare Access のJWTで認証する。iOS用の /v1/* とは認証方式が異なる
    if (url.pathname === "/v1/wc/sync") {
      const cors = corsHeaders(request, env);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      if (!(await isWebappAuthorized(request, env))) {
        return withHeaders(json({ error: "unauthorized" }, 401), cors);
      }
      if (request.method === "POST") return withHeaders(await handlePush(request, env), cors);
      if (request.method === "GET") return withHeaders(await handlePull(url, env), cors);
      return withHeaders(json({ error: "method not allowed" }, 405), cors);
    }
    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/v1/scans") {
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      return handlePostScans(request, env);
    }
    if (url.pathname === "/v1/export.csv") {
      if (request.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
      }
      return handleExportCsv(url, env);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- CORS

/**
 * 資格情報付き(credentials: include)のリクエストでは
 * Access-Control-Allow-Origin にワイルドカードを使えない。
 * 許可リストと一致したオリジンだけをそのまま返す。
 * 未設定・不一致の場合はCORSヘッダを付けない（ブラウザ側で遮断される）。
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !env.ALLOWED_ORIGINS) return {};
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return res;
  const merged = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(res.body, { status: res.status, headers: merged });
}

// ---------------------------------------------------------------- 認証

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.API_KEY) return false;
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  const token = match?.[1];
  if (!token) return false;
  return timingSafeEqualStr(token, env.API_KEY);
}

/**
 * webapp同期の認可。次のいずれかで通す。
 * 1. Cloudflare Access のJWTが有効（本番の想定経路）
 * 2. Bearer API_KEY（管理ツール等からの直接利用）
 * 3. DEV_OPEN_WC_SYNC=1（ローカル開発のみ。本番では未設定）
 *
 * Accessが未設定(ACCESS_* が無い)かつ 2,3 も無ければ、すべて拒否する。
 * 「設定漏れで全公開」にならないよう、既定は拒否側に倒す。
 */
async function isWebappAuthorized(request: Request, env: Env): Promise<boolean> {
  if (env.DEV_OPEN_WC_SYNC === "1") return true;
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const email = await verifyAccessJwt(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
    });
    if (email !== null) return true;
  }
  return isAuthorized(request, env);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------- POST /v1/scans（冪等取り込み）

async function handlePostScans(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const records = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) {
    return json({ error: 'body must be { "records": [...] }' }, 400);
  }
  if (records.length > MAX_RECORDS_PER_REQUEST) {
    return json({ error: `too many records (max ${MAX_RECORDS_PER_REQUEST})` }, 413);
  }

  const valid: CleanRecord[] = [];
  for (const raw of records) {
    const clean = validateRecord(raw);
    if (clean) valid.push(clean);
  }

  if (valid.length > 0) {
    // uuid 主キーに INSERT OR IGNORE: クライアントが再送しても重複しない
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO scans (uuid, wester_id, scanned_at, event, location, session_id, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    );
    await env.DB.batch(
      valid.map((r) =>
        stmt.bind(r.uuid, r.wester_id, r.scanned_at, r.event, r.location, r.session_id, r.device_id)
      )
    );
  }

  return json({ accepted: valid.length, rejected: records.length - valid.length });
}

function validateRecord(raw: unknown): CleanRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const uuid = typeof r.uuid === "string" ? r.uuid.toLowerCase() : "";
  const westerId = typeof r.wester_id === "string" ? r.wester_id : "";
  const scannedAt = typeof r.scanned_at === "string" ? r.scanned_at : "";
  if (!UUID_RE.test(uuid)) return null;
  if (!WESTER_ID_RE.test(westerId)) return null;
  if (scannedAt.length < 10 || scannedAt.length > 40) return null;
  return {
    uuid,
    wester_id: westerId,
    scanned_at: scannedAt,
    event: asOptionalString(r.event),
    location: asOptionalString(r.location),
    session_id: asOptionalString(r.session_id, 64),
    device_id: asOptionalString(r.device_id, 64),
  };
}

function asOptionalString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, maxLength);
}

// ------------------------------------- GET /v1/export.csv（JR側共有用CSV）

async function handleExportCsv(url: URL, env: Env): Promise<Response> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const event = url.searchParams.get("event");

  const conditions: string[] = [];
  const params: string[] = [];
  if (from) {
    // 日付のみ(YYYY-MM-DD)でも ISO8601 文字列比較でその日の0時以降に一致する
    conditions.push("scanned_at >= ?");
    params.push(from);
  }
  if (to) {
    if (DATE_ONLY_RE.test(to)) {
      // 日付のみ指定は「その日を含む」= 翌日0時未満
      conditions.push("scanned_at < ?");
      params.push(nextDay(to));
    } else {
      conditions.push("scanned_at <= ?");
      params.push(to);
    }
  }
  if (event) {
    conditions.push("event = ?");
    params.push(event);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const query =
    "SELECT uuid, wester_id, scanned_at, event, location, session_id, device_id, received_at" +
    ` FROM scans${where} ORDER BY scanned_at`;
  const { results } = await env.DB.prepare(query)
    .bind(...params)
    .all<Record<string, string | null>>();

  const lines = ["uuid,wester_id,scanned_at,event,location,session_id,device_id,received_at"];
  for (const row of results) {
    lines.push(
      [
        row.uuid,
        row.wester_id,
        row.scanned_at,
        row.event,
        row.location,
        row.session_id,
        row.device_id,
        row.received_at,
      ]
        .map((v) => csvEscape(v ?? ""))
        .join(",")
    );
  }
  // BOM付きUTF-8: Excelでの文字化け対策
  return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="wester_scans.csv"',
    },
  });
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return '"' + value.replaceAll('"', '""') + '"';
  }
  return value;
}

function nextDay(dateOnly: string): string {
  const base = new Date(`${dateOnly}T00:00:00Z`);
  return new Date(base.getTime() + 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 共通

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
