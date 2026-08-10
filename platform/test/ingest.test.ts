import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PROC, STATIONS, encodeHistoryBlock } from "../tools/lib/encode.mjs";
import { getJson, ingestPayload, postJson, rawRequest, request } from "./helpers";

const block = (seq: number, balance: number) =>
  encodeHistoryBlock({
    procType: PROC.fare,
    date: new Date(Date.UTC(2026, 7, 1 + (seq % 20))),
    entry: STATIONS.osaka,
    exit: STATIONS.kyobashi,
    balance,
    seq,
  });

describe("認証", () => {
  it("/v1/health はトークンなしで通る", async () => {
    const res = await rawRequest("/v1/health");
    expect(res.status).toBe(200);
  });

  it("トークンが違えば 401", async () => {
    const res = await request("/v1/sessions", { headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/ingest", () => {
  it("受け取った生HEXを全件保存する", async () => {
    const payload = ingestPayload({ blocks: [block(1, 4830), block(2, 4660), "0".repeat(32)] });
    const { status, body } = await postJson("/v1/ingest", payload);

    expect(status).toBe(200);
    expect(body.status).toBe("stored");
    expect(body.stored_blocks).toBe(3);

    const raw = await getJson(`/v1/sessions/${payload.session_id}/raw`);
    expect(raw.body.raw_observations).toHaveLength(3);
    expect(raw.body.raw_observations.map((r: any) => r.block_order)).toEqual([0, 1, 2]);
    // 未使用ブロックも「届いた事実」として残す（解釈段階で読み飛ばすだけ）
    expect(raw.body.raw_observations[2].raw_hex).toBe("0".repeat(32));
  });

  it("別セッションで同じ生HEXが届いたら、重複していても両方保存する", async () => {
    const shared = block(10, 3000);
    const first = ingestPayload({ blocks: [shared] });
    const second = ingestPayload({ blocks: [shared] });

    await postJson("/v1/ingest", first);
    await postJson("/v1/ingest", second);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_observations WHERE raw_hex = ?`,
    )
      .bind(shared)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);

    // 一方で解釈結果は1件に畳まれる（生と解釈の分離）
    const tx = await getJson("/v1/transactions");
    expect(tx.body.transactions.filter((t: any) => t.source_raw_hex === shared)).toHaveLength(1);
  });

  it("同じ session_id の再送は二重保存しない（転送レベルの冪等性）", async () => {
    const payload = ingestPayload({ blocks: [block(20, 2500), block(21, 2300)] });

    const first = await postJson("/v1/ingest", payload);
    const retry = await postJson("/v1/ingest", payload);

    expect(first.body.status).toBe("stored");
    expect(retry.body.status).toBe("duplicate_session");
    expect(retry.body.stored_blocks).toBe(0);

    const raw = await getJson(`/v1/sessions/${payload.session_id}/raw`);
    expect(raw.body.raw_observations).toHaveLength(2);
  });

  it("同じ session_id を別カードで使い回したら 409", async () => {
    const sessionId = crypto.randomUUID();
    await postJson("/v1/ingest", ingestPayload({ session_id: sessionId, blocks: [block(30, 1000)] }));
    const conflict = await postJson(
      "/v1/ingest",
      ingestPayload({
        session_id: sessionId,
        card_pseudonym: "mockcard-b-00000000000000000000000000000000",
        blocks: [block(30, 1000)],
      }),
    );
    expect(conflict.status).toBe(409);
  });

  it("HEXでないブロックだけを弾き、位置を返したうえで残りは保存する", async () => {
    const payload = ingestPayload({ blocks: [block(40, 900), "これはHEXではない", block(41, 700)] });
    const { body } = await postJson("/v1/ingest", payload);

    expect(body.stored_blocks).toBe(2);
    expect(body.rejected_blocks).toEqual([{ index: 1, reason: "not_a_hex_string" }]);
  });

  it("16バイト以外のHEXも保存し、解釈段階で unparsable として扱う", async () => {
    const payload = ingestPayload({ blocks: [block(50, 800), "DEADBEEF"] });
    const { body } = await postJson("/v1/ingest", payload);

    expect(body.stored_blocks).toBe(2);
    expect(body.derived.unparsable).toBe(1);
    expect(body.derived.derived).toBe(1);
  });

  it("iOSクライアントの camelCase + records 形式をそのまま受け付ける", async () => {
    // Swift の JSONEncoder は既定で camelCase を吐く。キー名の違いで
    // 生データを落とさないよう、受信側で別名を吸収する。
    const sessionId = crypto.randomUUID().toUpperCase(); // 実機は大文字UUID
    const { status, body } = await postJson("/v1/ingest", {
      sessionId,
      deviceId: "ios-A9E5AEBF",
      cardPseudonym: "627b3f262d73c0df3cac1b2a31d1f2c9a061ffad6f82af5fd1eade0f681679eb",
      readAt: "2026-08-11T08:50:03+09:00",
      records: [block(90, 1926), block(91, 1806)],
      clientVersion: "ios-probe/0.1.0",
    });

    expect(status).toBe(200);
    expect(body.session_id).toBe(sessionId);
    expect(body.stored_blocks).toBe(2);
    expect(body.derived.derived).toBe(2);

    const sessions = await getJson("/v1/sessions");
    expect(sessions.body.sessions[0].device_id).toBe("ios-A9E5AEBF");
    expect(sessions.body.sessions[0].client_version).toBe("ios-probe/0.1.0");
  });

  it("snake_case と camelCase が混在していても受け付ける", async () => {
    const { status, body } = await postJson("/v1/ingest", {
      session_id: crypto.randomUUID(),
      cardPseudonym: "mockcard-c-00000000000000000000000000000000",
      read_at: "2026-08-11T08:50:03+09:00",
      records: [block(95, 500)],
    });
    expect(status).toBe(200);
    expect(body.stored_blocks).toBe(1);
  });

  it("空ペイロードは 400", async () => {
    const { status } = await postJson("/v1/ingest", { session_id: "short" });
    expect(status).toBe(400);
  });
});

describe("被験者とカード仮名の対応", () => {
  it("participant_id 付きの投入で自動的に紐付く", async () => {
    const payload = ingestPayload({ participant_id: "P001", blocks: [block(60, 5000)] });
    const { body } = await postJson("/v1/ingest", payload);
    expect(body.participant_link).toEqual({ linked: true });

    const cards = await getJson("/v1/cards");
    expect(cards.body.cards[0].participant_id).toBe("P001");
  });

  it("再インストールで仮名が変わっても、同一被験者に複数仮名をぶら下げられる", async () => {
    const shared = block(70, 4000);
    await postJson(
      "/v1/ingest",
      ingestPayload({ participant_id: "P001", blocks: [shared, block(71, 3800)] }),
    );
    await postJson(
      "/v1/ingest",
      ingestPayload({
        participant_id: "P001",
        card_pseudonym: "mockcard-a2-0000000000000000000000000000000",
        device_id: "new-iphone",
        blocks: [shared, block(72, 3600)],
      }),
    );

    const participants = await getJson("/v1/participants");
    expect(participants.body.participants).toHaveLength(1);
    expect(participants.body.participants[0].card_count).toBe(2);

    // 仮名ごとには両方に derived が立つ（カード単位の集計はそのまま使える）
    const perCard = await getJson("/v1/transactions");
    expect(perCard.body.transactions.filter((t: any) => t.source_raw_hex === shared)).toHaveLength(2);

    // 被験者で見るときは同一取引を1件に畳む
    const perParticipant = await getJson("/v1/transactions?participant_id=P001");
    const merged = perParticipant.body.transactions.filter((t: any) => t.source_raw_hex === shared);
    expect(merged).toHaveLength(1);
    expect(merged[0].also_seen_as).toHaveLength(1);
    expect(perParticipant.body.deduped).toBe(1);
  });

  it("同じ仮名を別の被験者に付け替えようとしたら 409（上書きしない）", async () => {
    await postJson("/v1/ingest", ingestPayload({ participant_id: "P001", blocks: [block(80, 100)] }));
    const { status } = await postJson("/v1/participants/P002/cards", {
      card_pseudonym: "mockcard-a-00000000000000000000000000000000",
    });
    expect(status).toBe(409);
  });
});
