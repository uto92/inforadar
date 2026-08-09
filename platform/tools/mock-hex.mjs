#!/usr/bin/env node
/**
 * mock HEX 生成ツール。Phase 1 では iPhone を使わないので、これが唯一の入力源。
 *
 * POST /v1/ingest にそのまま投げられる JSON を標準出力へ書く。
 * ブロックの並びは実カードに合わせて新しい順（block_order 0 が最新）。
 *
 * 使い方:
 *   node tools/mock-hex.mjs
 *   node tools/mock-hex.mjs --card=mockcard-b-0000... --participant=P001 --records=8
 *   node tools/mock-hex.mjs | curl -sS -X POST http://localhost:8787/v1/ingest \
 *        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @-
 *
 * オプション:
 *   --card=<仮名>        card_pseudonym（既定: mockcard-a-...）
 *   --participant=<id>   participant_id。空文字にすると未割当のまま投入
 *   --session=<id>       session_id（既定: ランダムUUID。同じ値を2度使うと再送扱い）
 *   --device=<id>        device_id
 *   --records=<n>        履歴の生成件数（既定: 12）
 *   --start-seq=<n>      連番の開始値（既定: 1000）
 *   --start-balance=<円> 初期残額（既定: 5000）
 *   --start-date=<日付>  最初の利用日 YYYY-MM-DD（既定: 30日前）
 *   --blank=<n>          末尾に付ける未使用ブロック数（既定: 20件になるまで）
 */

import { buildMockHistory } from "./lib/encode.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);

const int = (key, fallback) => {
  const parsed = Number.parseInt(args[key] ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const blocks = buildMockHistory({
  records: int("records", 12),
  startSeq: int("start-seq", 1000),
  startBalance: int("start-balance", 5000),
  startDate: args["start-date"]
    ? new Date(`${args["start-date"]}T00:00:00Z`)
    : new Date(Date.now() - 30 * 86400_000),
  blankCount: args.blank === undefined ? null : int("blank", 0),
});

const payload = {
  session_id: args.session ?? crypto.randomUUID(),
  card_pseudonym: args.card ?? "mockcard-a-00000000000000000000000000000000",
  device_id: args.device ?? "mock-device-01",
  read_at: new Date().toISOString(),
  client_version: "mock-hex/0.1.0",
  blocks,
};

// --participant= を空文字で渡すと「未割当のカード仮名」を再現できる
const participantId = args.participant ?? "P001";
if (participantId) payload.participant_id = participantId;

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
