import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PROC, STATIONS, buildMockHistory, encodeHistoryBlock } from "../tools/lib/encode.mjs";
import { PARSER_VERSION } from "../src/parser";
import { getJson, ingestPayload, postJson, request } from "./helpers";

const CARD = "mockcard-a-00000000000000000000000000000000";

const fare = (seq: number, balance: number, day = 1) =>
  encodeHistoryBlock({
    procType: PROC.fare,
    date: new Date(Date.UTC(2026, 7, day)),
    entry: STATIONS.osaka,
    exit: STATIONS.kyobashi,
    balance,
    seq,
  });

describe("derived_transactions の生成", () => {
  it("未使用ブロックは解釈対象から外れるが、生データには残る", async () => {
    const payload = ingestPayload({
      blocks: [fare(1, 5000), "0".repeat(32), "0".repeat(32)],
    });
    const { body } = await postJson("/v1/ingest", payload);

    // 解釈側の集計は「内容が異なるブロック」単位。空きブロックは同一内容なので
    // uniqueBlocks は 2、うち 1 件が blank として読み飛ばされる
    expect(body.derived.rawRows).toBe(3);
    expect(body.derived.uniqueBlocks).toBe(2);
    expect(body.derived.blank).toBe(1);
    expect(body.derived.derived).toBe(1);

    // 受信側は届いたまま3行残る
    const raw = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raw_observations`).first<{ n: number }>();
    expect(raw?.n).toBe(3);
  });

  it("連番が連続する区間だけ利用額を推定し、飛んでいる区間は null にする", async () => {
    // seq 1,2,3 は連続、5 は間が抜けている（読み取れていない取引がある）
    await postJson(
      "/v1/ingest",
      ingestPayload({ blocks: [fare(1, 5000), fare(2, 4830), fare(3, 4660), fare(5, 4200)] }),
    );

    const { body } = await getJson(`/v1/transactions?card_pseudonym=${CARD}`);
    const bySeqAsc = [...body.transactions].reverse(); // 応答は新しい順
    expect(bySeqAsc.map((t: any) => t.amount_estimated)).toEqual([null, 170, 170, null]);
  });

  it("チャージは負の推定値（残額が増える）として出る", async () => {
    await postJson(
      "/v1/ingest",
      ingestPayload({
        blocks: [
          fare(1, 2000),
          encodeHistoryBlock({
            procType: PROC.charge,
            date: new Date(Date.UTC(2026, 7, 2)),
            entry: STATIONS.osaka,
            exit: STATIONS.osaka,
            balance: 5000,
            seq: 2,
          }),
        ],
      }),
    );

    const { body } = await getJson(`/v1/transactions?card_pseudonym=${CARD}`);
    const charge = body.transactions.find((t: any) => t.proc_type === PROC.charge);
    expect(charge.amount_estimated).toBe(-3000);
    expect(charge.proc_type_label).toBe("チャージ");
  });

  it("first_session_id はその生HEXを最初に運んできたセッションで固定される", async () => {
    const shared = fare(1, 5000);
    const first = ingestPayload({ blocks: [shared] });
    const second = ingestPayload({ blocks: [shared, fare(2, 4830)] });

    await postJson("/v1/ingest", first);
    await postJson("/v1/ingest", second);

    const row = await env.DB.prepare(
      `SELECT first_session_id FROM derived_transactions WHERE source_raw_hex = ?`,
    )
      .bind(shared)
      .first<{ first_session_id: string }>();
    expect(row?.first_session_id).toBe(first.session_id);

    // 再解析しても入れ替わらない（raw の受信順だけから決まるため）
    await postJson("/v1/reparse", {});
    const after = await env.DB.prepare(
      `SELECT first_session_id FROM derived_transactions WHERE source_raw_hex = ?`,
    )
      .bind(shared)
      .first<{ first_session_id: string }>();
    expect(after?.first_session_id).toBe(first.session_id);
  });

  it("derived には parser_version が必ず入る", async () => {
    await postJson("/v1/ingest", ingestPayload({ blocks: [fare(1, 5000)] }));
    const { body } = await getJson("/v1/parser");
    expect(body.current_parser_version).toBe(PARSER_VERSION);
    expect(body.by_parser_version).toEqual([{ parser_version: PARSER_VERSION, count: 1 }]);
    expect(body.stale).toBe(0);
  });
});

describe("POST /v1/reparse", () => {
  it("derived を全消ししても、生HEXから同じ内容を作り直せる", async () => {
    await postJson("/v1/ingest", ingestPayload({ blocks: buildMockHistory({ records: 12 }) }));

    const before = await env.DB.prepare(
      `SELECT transaction_key, used_date, proc_type, entry_station_code, exit_station_code,
              balance, amount_estimated, source_raw_hex, first_session_id
         FROM derived_transactions ORDER BY transaction_key`,
    ).all();
    expect(before.results.length).toBeGreaterThan(0);

    // 解釈結果を人為的に壊す（v2 で全滅した状況の再現）
    await env.DB.prepare(`DELETE FROM derived_transactions`).run();
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM derived_transactions`).first<{ n: number }>())?.n,
    ).toBe(0);

    const { body } = await postJson("/v1/reparse", {});
    expect(body.scope).toBe("all");

    const after = await env.DB.prepare(
      `SELECT transaction_key, used_date, proc_type, entry_station_code, exit_station_code,
              balance, amount_estimated, source_raw_hex, first_session_id
         FROM derived_transactions ORDER BY transaction_key`,
    ).all();
    expect(after.results).toEqual(before.results);
  });

  it("再解析は生データを一切減らさない", async () => {
    await postJson("/v1/ingest", ingestPayload({ blocks: buildMockHistory({ records: 8 }) }));
    const rawBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raw_observations`).first<{ n: number }>();

    await postJson("/v1/reparse", {});
    await postJson("/v1/reparse", {});

    const rawAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raw_observations`).first<{ n: number }>();
    expect(rawAfter?.n).toBe(rawBefore?.n);
  });

  it("何度実行しても件数が増えない（冪等）", async () => {
    await postJson("/v1/ingest", ingestPayload({ blocks: [fare(1, 5000), fare(2, 4830)] }));
    const first = await postJson("/v1/reparse", {});
    const second = await postJson("/v1/reparse", {});
    expect(second.body.stats.derived).toBe(first.body.stats.derived);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM derived_transactions`,
    ).first<{ n: number }>();
    expect(count?.n).toBe(first.body.stats.derived);
  });
});

describe("駅コードマスタの突き合わせ", () => {
  it("収載済みは駅名、未収載はコードのまま返す", async () => {
    await postJson("/v1/station-master", {
      csv: "01,2E,01,JR西日本,大阪環状線,大阪\n01,2E,05,JR西日本,大阪環状線,京橋",
    });
    await postJson(
      "/v1/ingest",
      ingestPayload({
        blocks: [
          fare(1, 5000),
          encodeHistoryBlock({
            procType: PROC.fare,
            date: new Date(Date.UTC(2026, 7, 3)),
            entry: STATIONS.osaka,
            exit: STATIONS.unmapped,
            balance: 4810,
            seq: 2,
          }),
        ],
      }),
    );

    const { body } = await getJson(`/v1/transactions?card_pseudonym=${CARD}`);
    const mapped = body.transactions.find((t: any) => t.exit_station_code === "01-2E-05");
    const unmapped = body.transactions.find((t: any) => t.exit_station_code === "01-2E-13");

    expect(mapped.entry_label).toBe("大阪環状線 大阪");
    expect(mapped.exit_label).toBe("大阪環状線 京橋");
    // 推測で駅名を作らず、コードをそのまま返す
    expect(unmapped.exit_label).toBe("01-2E-13");
  });
});

describe("GET /v1/transactions.csv", () => {
  it("BOM付きCSVで書き出す", async () => {
    await postJson("/v1/ingest", ingestPayload({ blocks: [fare(1, 5000)] }));
    const res = await request("/v1/transactions.csv");
    const text = await res.text();
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("used_date,participant_id,card_pseudonym");
  });
});
