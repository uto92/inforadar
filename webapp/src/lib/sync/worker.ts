/// Cloudflare Worker + D1 を同期先にするアダプタ。
///
/// 認証は合言葉（Bearerトークン）。バンドルには埋め込まず、受付スタッフが
/// 端末ごとに1回入力したものを localStorage から読む。
/// 埋め込むとURLを知る第三者が同期先のデータを読めてしまうため。

import type { CheckinRow, EventRow, ScanErrorRow } from "../db";
import { getSyncToken } from "../syncToken";
import type { PullResult, SyncBackend } from "./backend";

interface PushResponse {
  stored: { events: number; checkins: number; scanErrors: number };
  ignored: { events: number; checkins: number; scanErrors: number };
  rejected: { events: number; checkins: number; scanErrors: number };
}

function endpoint(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/wc/sync`;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const token = getSyncToken();
  if (!token) {
    // 合言葉が未設定。エンジンはこれをエラーとして扱い、画面に案内が出る
    throw new Error("同期の合言葉が未設定です。設定すると他の端末と集計が合算されます");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("同期の合言葉が違います。設定を確認してください");
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

    async pushCheckins(rows: CheckinRow[]) {
      await push({
        checkins: rows.map((r) => ({
          id: r.id,
          eventId: r.eventId,
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
        checkins: body.checkins ?? [],
        scanErrors: body.scanErrors ?? [],
        nextSince: body.nextSince,
        hasMore: body.hasMore ?? false,
      };
    },
  };
}
