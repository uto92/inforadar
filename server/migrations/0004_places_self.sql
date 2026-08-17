-- Migration 0004: 場所(place)の第一級化と自己チェックイン(self)の受け入れ
--
-- DESIGN.md の Phase 1-2。チェックインを (誰が, どこに, いつ) の3つ組へ拡張する。
--   1. wc_places を新設。場所はイベントから独立した概念（プロジェクト全体で共有）
--   2. wc_checkins に place_id（NULL許容）を追加。既存データは場所未指定のまま有効
--   3. method に 'self'（来場者自身の操作によるチェックイン）を追加
--
-- self_enabled は「この場所に来場者向けQRを掲示してよいか」。
-- 公開面(visit-self Worker)はこのフラグが立っている場所しか受け付けない。

CREATE TABLE wc_places (
  id TEXT PRIMARY KEY,              -- クライアント生成UUID（冪等キー）
  name TEXT NOT NULL,
  self_enabled INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL,          -- 作成元端末
  created_at TEXT NOT NULL,         -- ISO8601
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_wc_places_received ON wc_places(received_at);

-- SQLiteはCHECK制約を直接変更できないため、checkinsを作り直して移し替える
CREATE TABLE wc_checkins_new (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  place_id TEXT,                    -- 場所。NULL = 未指定（既存データ・場所を使わない運用）
  member_hash TEXT,
  suffix_hash TEXT,
  method TEXT NOT NULL CHECK (method IN ('scan', 'manual', 'nfc', 'self')),
  checked_in_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO wc_checkins_new
  (id, event_id, place_id, member_hash, suffix_hash, method, checked_in_at, device_id, received_at)
SELECT id, event_id, NULL, member_hash, suffix_hash, method, checked_in_at, device_id, received_at
FROM wc_checkins;

DROP TABLE wc_checkins;
ALTER TABLE wc_checkins_new RENAME TO wc_checkins;

-- 重複防止はイベント単位のまま（場所が違っても同一イベント内の同一人物は1回）
CREATE UNIQUE INDEX idx_wc_checkins_event_member
  ON wc_checkins(event_id, member_hash)
  WHERE member_hash IS NOT NULL;

CREATE UNIQUE INDEX idx_wc_checkins_event_suffix_manual
  ON wc_checkins(event_id, suffix_hash)
  WHERE method = 'manual';

CREATE INDEX idx_wc_checkins_event ON wc_checkins(event_id);
CREATE INDEX idx_wc_checkins_received ON wc_checkins(received_at);
CREATE INDEX idx_wc_checkins_place ON wc_checkins(event_id, place_id);
