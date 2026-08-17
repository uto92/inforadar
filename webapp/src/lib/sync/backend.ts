import type { CheckinRow, EventRow, PlaceRow, ScanErrorRow } from "../db";
import { createSupabaseBackend } from "./supabase";
import { createWorkerBackend } from "./worker";

/// 同期先の差し込み点。実装を追加する場合はこのインタフェースを満たして
/// resolveBackend() に登録する（アプリ本体は SyncBackend しか知らない）。

/** 他端末ぶんを取り込むための取得結果。salt はサーバに存在しないため含まない */
export interface PullResult {
  events: Array<Omit<EventRow, "salt" | "synced">>;
  places?: Array<Omit<PlaceRow, "synced">>;
  checkins: Array<Omit<CheckinRow, "synced">>;
  scanErrors: Array<Omit<ScanErrorRow, "synced">>;
  /** 次回の取得開始位置（サーバ採番。端末時計に依存しない） */
  nextSince: string;
  /** 上限に達して続きがある場合 true */
  hasMore: boolean;
}

export interface SyncBackend {
  readonly name: string;
  pushEvents(rows: EventRow[]): Promise<void>;
  /** 場所の同期。未対応の同期先（Supabase版）は undefined でよい */
  pushPlaces?(rows: PlaceRow[]): Promise<void>;
  pushCheckins(rows: CheckinRow[]): Promise<void>;
  pushScanErrors(rows: ScanErrorRow[]): Promise<void>;
  /** 未実装の同期先（Supabase版）は undefined。その場合はpushのみ動作する */
  pull?(since: string | null): Promise<PullResult>;
}

/**
 * 同期先の決定。
 * 1. VITE_SYNC_URL があれば Cloudflare Worker（推奨。資格情報をJSに埋め込まない）
 * 2. VITE_SUPABASE_* があれば Supabase
 * 3. どちらもなければ null（ローカルのみモード）
 */
export function resolveBackend(): SyncBackend | null {
  return createWorkerBackend() ?? createSupabaseBackend();
}
