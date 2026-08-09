import { SELF } from "cloudflare:test";

const BASE = "https://datahub.test";
export const TOKEN = "test-token";

/** 認証ヘッダを付けずに Worker を叩く */
export function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, init);
}

export function request(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function postJson<T = any>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await request(path, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

export async function getJson<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await request(path);
  return { status: res.status, body: (await res.json()) as T };
}

/** ingest ペイロードの雛形。テストごとに必要な部分だけ差し替える */
export function ingestPayload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: crypto.randomUUID(),
    card_pseudonym: "mockcard-a-00000000000000000000000000000000",
    device_id: "test-device",
    read_at: "2026-08-09T12:00:00+09:00",
    client_version: "vitest/0.1.0",
    blocks: [],
    ...overrides,
  };
}
