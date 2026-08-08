import type { CheckinRow, EventRow, ScanErrorRow } from "../db";
import { createSupabaseBackend } from "./supabase";

/// 同期先の差し込み点。実装を追加する場合はこのインタフェースを満たして
/// resolveBackend() に登録する（アプリ本体は SyncBackend しか知らない）。

export interface SyncBackend {
  readonly name: string;
  pushEvents(rows: EventRow[]): Promise<void>;
  pushCheckins(rows: CheckinRow[]): Promise<void>;
  pushScanErrors(rows: ScanErrorRow[]): Promise<void>;
}

/** 環境変数が設定されていれば Supabase、なければ null（ローカルのみモード） */
export function resolveBackend(): SyncBackend | null {
  return createSupabaseBackend();
}
