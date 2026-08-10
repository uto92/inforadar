/**
 * 受信レイヤ（read_sessions + raw_observations）。
 *
 * ここでの唯一の責務は「届いた事実をそのまま残すこと」。
 * 解釈はしない。重複も判定しない。同じ生HEXが何度届いても、届いた回数だけ
 * raw_observations に行が増えるのが正しい。
 */

import { normalizeHex } from "./parser";

/** 転送単位（1回のカード読取） */
export interface IngestPayload {
  session_id: string;
  card_pseudonym: string;
  device_id?: string | null;
  /** 端末が付与した読取時刻（ISO8601 +09:00） */
  read_at: string;
  client_version?: string | null;
  /** 判明していれば被験者に紐付ける。未指定なら未割当のまま受け入れる */
  participant_id?: string | null;
  /** 読出順（配列の index = block_order）。文字列HEX または {raw_hex} */
  blocks: (string | { raw_hex: string })[];
}

/**
 * キー名の別名。Swift の JSONEncoder は既定で camelCase を吐くため、
 * iOS クライアントは snake_case へ変換せずに送ってくることがある。
 * 受信側で吸収しておく（キー名の違いで生データを落とすのは本末転倒なので）。
 * 履歴ブロックの配列名も `records` を受け付ける。
 */
const KEY_ALIASES = {
  session_id: ["session_id", "sessionId"],
  card_pseudonym: ["card_pseudonym", "cardPseudonym"],
  device_id: ["device_id", "deviceId"],
  read_at: ["read_at", "readAt"],
  client_version: ["client_version", "clientVersion"],
  participant_id: ["participant_id", "participantId"],
  blocks: ["blocks", "records"],
} as const;

/** 別名を吸収して正規のキー名に寄せる。値の検証はしない */
function canonicalize(body: Record<string, unknown>): Partial<IngestPayload> {
  const out: Record<string, unknown> = {};
  for (const [canonical, aliases] of Object.entries(KEY_ALIASES)) {
    for (const alias of aliases) {
      if (body[alias] !== undefined && body[alias] !== null) {
        out[canonical] = body[alias];
        break;
      }
    }
  }
  return out as Partial<IngestPayload>;
}

export interface RejectedBlock {
  index: number;
  reason: string;
}

export type ValidationResult =
  | { ok: true; value: NormalizedPayload }
  | { ok: false; error: string };

export interface NormalizedPayload {
  sessionId: string;
  cardPseudonym: string;
  deviceId: string | null;
  readAt: string;
  clientVersion: string | null;
  participantId: string | null;
  /** 正規化済み（大文字HEX）の保存対象ブロック。block_order は元配列の index */
  blocks: { blockOrder: number; rawHex: string }[];
  /** HEXとして保存できなかったブロック（レスポンスで位置を返す） */
  rejected: RejectedBlock[];
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CARD_PSEUDONYM_RE = /^[A-Za-z0-9_-]{8,128}$/;
const PARTICIPANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BLOCKS = 256;
/** 生HEX 1件の上限（バイト）。履歴は16バイトだが、将来の別ブロック取得も見越して緩めに取る */
const MAX_BLOCK_BYTES = 256;

export function validateIngest(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const p = canonicalize(body as Record<string, unknown>);

  if (typeof p.session_id !== "string" || !SESSION_ID_RE.test(p.session_id)) {
    return { ok: false, error: "session_id must be a client-generated id (8-64 chars, [A-Za-z0-9_-])" };
  }
  if (typeof p.card_pseudonym !== "string" || !CARD_PSEUDONYM_RE.test(p.card_pseudonym)) {
    return { ok: false, error: "card_pseudonym must be 8-128 chars of [A-Za-z0-9_-]" };
  }
  if (typeof p.read_at !== "string" || Number.isNaN(Date.parse(p.read_at))) {
    return { ok: false, error: "read_at must be an ISO8601 datetime" };
  }
  if (p.participant_id != null && (typeof p.participant_id !== "string" || !PARTICIPANT_ID_RE.test(p.participant_id))) {
    return { ok: false, error: "participant_id must be 1-64 chars of [A-Za-z0-9_-]" };
  }
  if (!Array.isArray(p.blocks) || p.blocks.length === 0) {
    return { ok: false, error: "blocks must be a non-empty array" };
  }
  if (p.blocks.length > MAX_BLOCKS) {
    return { ok: false, error: `blocks must contain at most ${MAX_BLOCKS} entries` };
  }

  const blocks: { blockOrder: number; rawHex: string }[] = [];
  const rejected: RejectedBlock[] = [];

  p.blocks.forEach((entry, index) => {
    const rawInput =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null && typeof entry.raw_hex === "string"
          ? entry.raw_hex
          : null;
    if (rawInput === null) {
      rejected.push({ index, reason: "not_a_hex_string" });
      return;
    }
    const hex = normalizeHex(rawInput);
    if (hex === null) {
      // HEX でないものは raw_hex 列の意味を壊すので保存しない。
      // 捨てた事実は必ずレスポンスで返し、端末側に残せるようにする。
      rejected.push({ index, reason: "not_a_hex_string" });
      return;
    }
    if (hex.length / 2 > MAX_BLOCK_BYTES) {
      rejected.push({ index, reason: "too_long" });
      return;
    }
    // 長さが16バイトでなくても保存する。妥当性の判断はパーサの仕事であり、
    // 受信側で切り捨てると将来の再解析で復元できなくなる。
    blocks.push({ blockOrder: index, rawHex: hex });
  });

  if (blocks.length === 0) {
    return { ok: false, error: "no storable hex block in payload" };
  }

  return {
    ok: true,
    value: {
      sessionId: p.session_id,
      cardPseudonym: p.card_pseudonym,
      deviceId: typeof p.device_id === "string" ? p.device_id : null,
      readAt: p.read_at,
      clientVersion: typeof p.client_version === "string" ? p.client_version : null,
      participantId: typeof p.participant_id === "string" ? p.participant_id : null,
      blocks,
      rejected,
    },
  };
}

export type StoreResult =
  | { status: "stored"; storedBlocks: number }
  | { status: "duplicate_session"; storedBlocks: 0 }
  | { status: "session_id_conflict"; storedBlocks: 0 };

/**
 * セッションと生ブロックを保存する。
 *
 * session_id はクライアント生成なので、通信リトライで同じ本文が2回届きうる。
 * それは「同じ受信が2回」ではなく「1回の受信の再送」なので、二重保存しない
 * （転送レベルの冪等性）。一方、別セッションで同じ生HEXが届いた場合は
 * 別の受信事実なので必ず両方保存する（内容レベルの重複排除はしない）。
 */
export async function storeSession(
  db: D1Database,
  payload: NormalizedPayload,
  receivedAt: string,
): Promise<StoreResult> {
  const existing = await db
    .prepare(`SELECT card_pseudonym FROM read_sessions WHERE session_id = ?`)
    .bind(payload.sessionId)
    .first<{ card_pseudonym: string }>();

  if (existing) {
    return existing.card_pseudonym === payload.cardPseudonym
      ? { status: "duplicate_session", storedBlocks: 0 }
      : { status: "session_id_conflict", storedBlocks: 0 };
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO read_sessions
           (session_id, card_pseudonym, device_id, read_at, received_at, record_count, client_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        payload.sessionId,
        payload.cardPseudonym,
        payload.deviceId,
        payload.readAt,
        receivedAt,
        payload.blocks.length,
        payload.clientVersion,
      ),
  ];

  for (const block of payload.blocks) {
    statements.push(
      db
        .prepare(
          `INSERT INTO raw_observations (session_id, block_order, raw_hex, received_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(payload.sessionId, block.blockOrder, block.rawHex, receivedAt),
    );
  }

  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }

  return { status: "stored", storedBlocks: payload.blocks.length };
}

export interface LinkResult {
  linked: boolean;
  /** 既に別の被験者に紐付いていた場合、その participant_id */
  conflictWith?: string;
}

/**
 * カード仮名を被験者に紐付ける。
 *
 * 端末の再インストールで同一実カードの仮名が変わるため、1被験者に複数仮名が
 * 紐づくのは正常系。逆に「1仮名が複数被験者」は異常なので上書きせず報告する。
 */
export async function linkCard(
  db: D1Database,
  participantId: string,
  cardPseudonym: string,
  deviceId: string | null,
  now: string,
  note: string | null = null,
): Promise<LinkResult> {
  await db
    .prepare(`INSERT OR IGNORE INTO participants (participant_id, label, created_at) VALUES (?, NULL, ?)`)
    .bind(participantId, now)
    .run();

  const existing = await db
    .prepare(`SELECT participant_id FROM participant_cards WHERE card_pseudonym = ?`)
    .bind(cardPseudonym)
    .first<{ participant_id: string }>();

  if (existing) {
    return existing.participant_id === participantId
      ? { linked: true }
      : { linked: false, conflictWith: existing.participant_id };
  }

  await db
    .prepare(
      `INSERT INTO participant_cards (card_pseudonym, participant_id, device_id, first_seen_at, note)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(cardPseudonym, participantId, deviceId, now, note)
    .run();

  return { linked: true };
}
