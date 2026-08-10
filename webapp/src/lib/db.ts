import Dexie, { type EntityTable } from "dexie";
import { getDeviceId } from "./deviceId";
import { memberHash, newSalt, suffixHash } from "./hash";
import { SUFFIX_LEN, normalizeScan, type CardMode } from "./normalize";

/// IndexedDB（Dexie）。ローカルが常に正で、Supabaseは後付けの同期先。
/// synced は 0/1（IndexedDBはbooleanをインデックスできないため）。

export interface EventRow {
  id: string; // クライアント生成UUID
  name: string;
  eventDate: string; // YYYY-MM-DD
  venue: string;
  salt: string; // ハッシュソルト（プロジェクト共通）
  /** 受け付けるカード。未設定は "any"（発行元を問わない） */
  cardMode?: CardMode;
  deviceId: string;
  createdAt: string; // ISO8601
  synced: 0 | 1;
}

export interface CheckinRow {
  id: string; // クライアント生成UUID = 同期の冪等キー
  eventId: string;
  memberHash: string | null; // scan時のみ。manual時はnull
  suffixHash: string; // 末尾6桁の照合キー（scan/manual共通）
  method: "scan" | "manual";
  checkedInAt: string; // ISO8601
  deviceId: string;
  synced: 0 | 1;
}

export interface ScanErrorRow {
  id: string;
  eventId: string;
  kind: "duplicate" | "invalid_format";
  memberHash: string | null;
  suffixHash: string | null;
  symbology: string | null;
  occurredAt: string;
  deviceId: string;
  synced: 0 | 1;
}

/** 端末に保存する設定値（プロジェクト共通ソルト等） */
export interface MetaRow {
  key: string;
  value: string;
}

export const db = new Dexie("wester-checkin") as Dexie & {
  events: EntityTable<EventRow, "id">;
  checkins: EntityTable<CheckinRow, "id">;
  scanErrors: EntityTable<ScanErrorRow, "id">;
  meta: EntityTable<MetaRow, "key">;
};

db.version(1).stores({
  events: "id, synced, createdAt",
  checkins: "id, eventId, synced, checkedInAt, [eventId+memberHash], [eventId+suffixHash]",
  scanErrors: "id, eventId, synced, occurredAt",
});

// v2: プロジェクト共通ソルトを保持する meta を追加。
// 既存イベントのソルトは書き換えない（記録済みのハッシュと照合できなくなるため）
db.version(2).stores({
  events: "id, synced, createdAt",
  checkins: "id, eventId, synced, checkedInAt, [eventId+memberHash], [eventId+suffixHash]",
  scanErrors: "id, eventId, synced, occurredAt",
  meta: "key",
});

/// プロジェクト共通ソルト。
///
/// イベントごとに別のソルトを使うと、同じ来場者でもイベントが変わると
/// 別のハッシュになり、イベントをまたいだ再訪を判定できない。
/// 横断分析を行うため、全イベントで同一のソルトを使う。
///
/// 代償として、このソルトが漏れると全イベントのハッシュが一度に
/// 逆引き可能になる（12桁は全探索できるため）。取り扱いは鍵と同じ。

const PROJECT_SALT_KEY = "projectSalt";

export async function getProjectSalt(): Promise<string | null> {
  const row = await db.meta.get(PROJECT_SALT_KEY);
  return row?.value ?? null;
}

/** 既存の値があればそれを返し、無ければ生成して保存する */
export async function ensureProjectSalt(): Promise<string> {
  const existing = await getProjectSalt();
  if (existing) return existing;
  const salt = newSalt();
  await db.meta.put({ key: PROJECT_SALT_KEY, value: salt });
  return salt;
}

/**
 * 別端末から引き継いだソルトを採用する。
 * 既に別の値が入っている場合は上書きしない（記録済みのハッシュと
 * 照合できなくなるため）。採用したかどうかを返す。
 */
export async function adoptProjectSalt(salt: string): Promise<boolean> {
  const existing = await getProjectSalt();
  if (existing && existing !== salt) return false;
  if (!existing) await db.meta.put({ key: PROJECT_SALT_KEY, value: salt });
  return true;
}

// ---------------------------------------------------------------- イベント

export async function createEvent(input: {
  name: string;
  eventDate: string;
  venue: string;
  cardMode?: CardMode;
}): Promise<EventRow> {
  const row: EventRow = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    eventDate: input.eventDate,
    venue: input.venue.trim(),
    salt: await ensureProjectSalt(),
    cardMode: input.cardMode ?? "any",
    deviceId: getDeviceId(),
    createdAt: new Date().toISOString(),
    synced: 0,
  };
  await db.events.add(row);
  return row;
}

// ---------------------------------------------------------------- チェックイン

export type CheckinOutcome =
  | { status: "ok"; displaySuffix: string; method: "scan" | "manual" }
  | {
      status: "duplicate";
      /** exact: member_hash一致（確実） / suffix: 末尾6桁一致（同一人物の可能性が高い） */
      match: "exact" | "suffix";
      matchedAt: string;
      /** suffix一致時のみ: 「別人として記録」で挿入する準備済み行 */
      pendingRow: CheckinRow | null;
      displaySuffix: string;
    }
  | { status: "invalid"; reason: string };

/** スキャン結果を判定して記録する。生の会員IDはこの関数の外に出さない。 */
export async function recordScan(
  event: EventRow,
  rawText: string,
  symbology: string
): Promise<CheckinOutcome> {
  const now = new Date().toISOString();
  const normalized = normalizeScan(rawText, event.cardMode ?? "any");
  if (!normalized.ok) {
    await db.scanErrors.add({
      id: crypto.randomUUID(),
      eventId: event.id,
      kind: "invalid_format",
      memberHash: null,
      suffixHash: null,
      symbology,
      occurredAt: now,
      deviceId: getDeviceId(),
      synced: 0,
    });
    return { status: "invalid", reason: normalized.reason };
  }

  const memberId = normalized.memberId;
  const displaySuffix = memberId.slice(-4);
  const mh = await memberHash(event.salt, memberId);
  const sh = await suffixHash(event.salt, memberId.slice(-SUFFIX_LEN));

  // 同一イベント内の同一ID（member_hash完全一致）
  const exact = await db.checkins
    .where("[eventId+memberHash]")
    .equals([event.id, mh])
    .first();
  if (exact) {
    await addDuplicateError(event.id, mh, sh, symbology, now);
    return {
      status: "duplicate",
      match: "exact",
      matchedAt: exact.checkedInAt,
      pendingRow: null,
      displaySuffix,
    };
  }

  const row: CheckinRow = {
    id: crypto.randomUUID(),
    eventId: event.id,
    memberHash: mh,
    suffixHash: sh,
    method: "scan",
    checkedInAt: now,
    deviceId: getDeviceId(),
    synced: 0,
  };

  // 手入力（末尾6桁）で先に受付済みの同一人物との突合
  const manualMatch = await db.checkins
    .where("[eventId+suffixHash]")
    .equals([event.id, sh])
    .and((r) => r.method === "manual")
    .first();
  if (manualMatch) {
    await addDuplicateError(event.id, mh, sh, symbology, now);
    return {
      status: "duplicate",
      match: "suffix",
      matchedAt: manualMatch.checkedInAt,
      pendingRow: row,
      displaySuffix,
    };
  }

  await db.checkins.add(row);
  return { status: "ok", displaySuffix, method: "scan" };
}

/** 手入力フォールバック（会員ID末尾6桁）。 */
export async function recordManual(event: EventRow, digits: string): Promise<CheckinOutcome> {
  const trimmed = digits.trim();
  if (!new RegExp(`^\\d{${SUFFIX_LEN}}$`).test(trimmed)) {
    return { status: "invalid", reason: "manual_format" };
  }
  const now = new Date().toISOString();
  const sh = await suffixHash(event.salt, trimmed);
  const displaySuffix = trimmed.slice(-4);

  const row: CheckinRow = {
    id: crypto.randomUUID(),
    eventId: event.id,
    memberHash: null,
    suffixHash: sh,
    method: "manual",
    checkedInAt: now,
    deviceId: getDeviceId(),
    synced: 0,
  };

  // 手入力はスキャン済み・手入力済みの両方と末尾6桁で突合
  const match = await db.checkins
    .where("[eventId+suffixHash]")
    .equals([event.id, sh])
    .first();
  if (match) {
    await addDuplicateError(event.id, null, sh, "MANUAL", now);
    return {
      status: "duplicate",
      match: "suffix",
      matchedAt: match.checkedInAt,
      pendingRow: row,
      displaySuffix,
    };
  }

  await db.checkins.add(row);
  return { status: "ok", displaySuffix, method: "manual" };
}

/** 「別人として記録」: suffix一致の警告後にスタッフ判断で記録する */
export async function commitPending(row: CheckinRow): Promise<void> {
  await db.checkins.add(row);
}

async function addDuplicateError(
  eventId: string,
  mh: string | null,
  sh: string | null,
  symbology: string,
  occurredAt: string
): Promise<void> {
  await db.scanErrors.add({
    id: crypto.randomUUID(),
    eventId,
    kind: "duplicate",
    memberHash: mh,
    suffixHash: sh,
    symbology,
    occurredAt,
    deviceId: getDeviceId(),
    synced: 0,
  });
}
