import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CheckinRow, EventRow, ScanErrorRow } from "../db";
import type { SyncBackend } from "./backend";

/// Supabase同期アダプタ。VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が
/// 両方設定されているときだけ有効になる。

export function createSupabaseBackend(): SyncBackend | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const client = createClient(url, key);

  return {
    name: "supabase",
    async pushEvents(rows) {
      await upsertIgnoreDuplicates(client, "events", rows.map(mapEvent));
    },
    async pushCheckins(rows) {
      await upsertIgnoreDuplicates(client, "checkins", rows.map(mapCheckin));
    },
    async pushScanErrors(rows) {
      await upsertIgnoreDuplicates(client, "scan_errors", rows.map(mapScanError));
    },
  };
}

/// id 主キーで ignoreDuplicates upsert = 再送しても重複しない。
/// checkins には (event_id, member_hash) の部分ユニーク制約もあるため、
/// バッチが 23505 で失敗した場合は1行ずつ再試行し、制約違反行はスキップ扱いにする。
async function upsertIgnoreDuplicates(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await client
    .from(table)
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (!error) return;
  if (error.code !== "23505") throw new Error(`${table}: ${error.message}`);
  for (const row of rows) {
    const { error: rowError } = await client
      .from(table)
      .upsert(row, { onConflict: "id", ignoreDuplicates: true });
    if (rowError && rowError.code !== "23505") {
      throw new Error(`${table}: ${rowError.message}`);
    }
  }
}

function mapEvent(row: EventRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    event_date: row.eventDate,
    venue: row.venue,
    salt: row.salt,
    device_id: row.deviceId,
    created_at: row.createdAt,
  };
}

function mapCheckin(row: CheckinRow): Record<string, unknown> {
  return {
    id: row.id,
    event_id: row.eventId,
    member_hash: row.memberHash,
    suffix_hash: row.suffixHash,
    method: row.method,
    checked_in_at: row.checkedInAt,
    device_id: row.deviceId,
  };
}

function mapScanError(row: ScanErrorRow): Record<string, unknown> {
  return {
    id: row.id,
    event_id: row.eventId,
    kind: row.kind,
    member_hash: row.memberHash,
    suffix_hash: row.suffixHash,
    symbology: row.symbology,
    occurred_at: row.occurredAt,
    device_id: row.deviceId,
  };
}
