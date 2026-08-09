import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// テスト間でDBを空に戻す。件数を数えるテストが多いので、
// ストレージ分離の挙動に依存せず自前で初期化しておく。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM derived_transactions"),
    env.DB.prepare("DELETE FROM raw_observations"),
    env.DB.prepare("DELETE FROM read_sessions"),
    env.DB.prepare("DELETE FROM participant_cards"),
    env.DB.prepare("DELETE FROM participants"),
    env.DB.prepare("DELETE FROM station_master"),
  ]);
});
