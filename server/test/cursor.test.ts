/// 増分取得カーソル（computeNextSince）の単体テスト。
///
///   node --test --experimental-strip-types test/cursor.test.ts
///
/// 実DBでこの分岐を踏むには PULL_LIMIT(2000) 件以上の投入が要り、
/// 打ち切りの組み合わせも網羅できないため純関数として切り出して検証する。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeNextSince } from "../src/webappSync.ts";

/** received_at だけを持つ行を n 件、`base` から1msずつ進めて作る */
const rows = (base: string, n: number) => {
  const start = Date.parse(base);
  return Array.from({ length: n }, (_, i) => ({
    received_at: new Date(start + i).toISOString(),
  }));
};

const CURSOR = "2026-08-01T00:00:00.000Z";

test("全種別が空ならカーソルは動かない", () => {
  const r = computeNextSince([[], [], [], []], CURSOR, 10);
  assert.equal(r.nextSince, CURSOR);
  assert.equal(r.hasMore, false);
});

test("打ち切りが無ければ全種別の最大へ進む", () => {
  const r = computeNextSince(
    [rows("2026-08-02T00:00:00.000Z", 3), [], rows("2026-08-03T00:00:00.000Z", 2), []],
    CURSOR,
    10
  );
  assert.equal(r.nextSince, "2026-08-03T00:00:00.001Z");
  assert.equal(r.hasMore, false);
});

test("打ち切られた種別より先へは進まない（レビュー指摘のmajor）", () => {
  // checkins が limit で打ち切られ、同じ応答に「後から更新された場所」が載る状況。
  // 全種別の max を取る旧実装ではカーソルが 08-09 まで飛び、
  // 打ち切られた checkins の続き（08-02 以降）が二度と取れなくなっていた。
  const checkins = rows("2026-08-02T00:00:00.000Z", 10); // ちょうど limit
  const places = rows("2026-08-09T00:00:00.000Z", 1); // upsert で received_at が進んだ場所
  const r = computeNextSince([[], places, checkins, []], CURSOR, 10);

  assert.equal(r.hasMore, true, "続きがあると伝えること");
  assert.equal(r.nextSince, "2026-08-02T00:00:00.009Z", "打ち切られた checkins の末尾で止まること");
  // 実際に取りこぼしが起きないことの確認: 打ち切られた種別のどの行も
  // 次回の `received_at > since` で再取得できる位置にカーソルがある
  const dropped = rows("2026-08-02T00:00:00.000Z", 30).slice(10);
  assert.ok(
    dropped.every((row) => row.received_at > r.nextSince),
    "打ち切られた続きの行がカーソルより後ろに残っていること"
  );
  // 進んだ場所(places)は次回もう一度返るが、pull側は id で上書き取り込みのため無害
  assert.ok(places[0].received_at > r.nextSince);
});

test("複数種別が同時に打ち切られたら最も古い末尾で止まる", () => {
  const a = rows("2026-08-05T00:00:00.000Z", 10);
  const b = rows("2026-08-02T00:00:00.000Z", 10); // こちらが古い
  const r = computeNextSince([a, b, [], []], CURSOR, 10);
  assert.equal(r.nextSince, "2026-08-02T00:00:00.009Z");
  assert.equal(r.hasMore, true);
});

test("カーソルが後退することはない", () => {
  // 何らかの理由で cursor より古い行だけが返っても、since を巻き戻さない
  const old = rows("2020-01-01T00:00:00.000Z", 2);
  const r = computeNextSince([old, [], [], []], CURSOR, 10);
  assert.equal(r.nextSince, CURSOR);
});

test("received_at が欠けた行は無視される", () => {
  const broken = [{ received_at: null }, { received_at: undefined }];
  const r = computeNextSince([broken, [], [], []], CURSOR, 10);
  assert.equal(r.nextSince, CURSOR);
  assert.equal(r.hasMore, false);
});

test("打ち切られた種別の末尾が読めない場合は他の種別で判断する", () => {
  // 打ち切られたが末尾の received_at が壊れている異常系。
  // 進めないことより、無限ループしないことを優先して全体maxへ進める
  const broken = Array.from({ length: 10 }, () => ({ received_at: null }));
  const r = computeNextSince([broken, rows("2026-08-04T00:00:00.000Z", 1), [], []], CURSOR, 10);
  assert.equal(r.nextSince, "2026-08-04T00:00:00.000Z");
  assert.equal(r.hasMore, false);
});
