/// Cloudflare Worker + D1 を同期先にするアダプタ。
///
/// 認証は Cloudflare Access。アプリ自体もこのWorkerから配信しているため、
/// APIとアプリは同一オリジンであり、Accessのセッションcookieがそのまま届く。
/// 資格情報をJSバンドルに埋め込まないので、URLを知る第三者がデータを読むことはない。

import type { CheckinRow, EventRow, PlaceRow, ScanErrorRow } from "../db";
import type { PullResult, SyncBackend } from "./backend";

interface PushResponse {
  stored: { events: number; places: number; checkins: number; scanErrors: number };
  ignored: { events: number; places: number; checkins: number; scanErrors: number };
  rejected: { events: number; places: number; checkins: number; scanErrors: number };
}

function endpoint(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/wc/sync`;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  // Cloudflare Access のセッションcookieを送る（同一オリジン）
  const res = await fetch(url, { ...init, credentials: "include" });
  if (!res.ok) {
    // Accessの認証切れ。再読み込みでログイン画面に飛ぶ
    if (res.status === 401 || res.status === 403) {
      throw new Error("認証が切れました。ページを再読み込みしてログインし直してください");
    }
    throw new Error(`同期先がエラーを返しました (HTTP ${res.status})`);
  }
  return res;
}

export function createWorkerBackend(): SyncBackend | null {
  const base = import.meta.env.VITE_SYNC_URL;
  if (!base) return null;
  const url = endpoint(base);

  async function push(body: Record<string, unknown>): Promise<PushResponse> {
    const res = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as PushResponse;
  }

  return {
    name: "cloudflare-worker",

    async pushEvents(rows: EventRow[]) {
      // salt は送らない。サーバはハッシュしか受け取らないため復元にも使えない
      await push({
        events: rows.map((r) => ({
          id: r.id,
          name: r.name,
          eventDate: r.eventDate,
          venue: r.venue,
          deviceId: r.deviceId,
          createdAt: r.createdAt,
        })),
      });
    },

    async pushPlaces(rows: PlaceRow[]) {
      await push({
        places: rows.map((r) => ({
          id: r.id,
          name: r.name,
          selfEnabled: r.selfEnabled,
          deviceId: r.deviceId,
          createdAt: r.createdAt,
        })),
      });
    },

    async pushCheckins(rows: CheckinRow[]) {
      await push({
        checkins: rows.map((r) => ({
          id: r.id,
          eventId: r.eventId,
          placeId: r.placeId ?? null,
          memberHash: r.memberHash,
          suffixHash: r.suffixHash,
          method: r.method,
          checkedInAt: r.checkedInAt,
          deviceId: r.deviceId,
        })),
      });
    },

    async pushScanErrors(rows: ScanErrorRow[]) {
      await push({
        scanErrors: rows.map((r) => ({
          id: r.id,
          eventId: r.eventId,
          kind: r.kind,
          memberHash: r.memberHash,
          suffixHash: r.suffixHash,
          symbology: r.symbology,
          occurredAt: r.occurredAt,
          deviceId: r.deviceId,
        })),
      });
    },

    async pull(since: string | null): Promise<PullResult> {
      const query = since ? `?since=${encodeURIComponent(since)}` : "";
      const res = await request(`${url}${query}`, { method: "GET" });
      const body = (await res.json()) as PullResult;
      return {
        events: body.events ?? [],
        places: body.places ?? [],
        checkins: body.checkins ?? [],
        scanErrors: body.scanErrors ?? [],
        nextSince: body.nextSince,
        hasMore: body.hasMore ?? false,
      };
    },
  };
}
