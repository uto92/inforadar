-- Migration 0003: NFC（交通系ICカード等）由来のチェックインを受け入れる
--
-- iOS のNFCプローブはカード固定の仮名（cardPseudonym, 64桁hex）を出力する。
-- これは「同じ人が再訪したか」の判定キーとして、バーコード由来のハッシュと
-- 同じ役割を果たすため、同じ wc_checkins に統合して集計できるようにする。
--
-- 変更点は2つ。SQLiteはCHECK制約とNOT NULLを直接変更できないため、
-- テーブルを作り直して移し替える。
--   1. method に 'nfc' を追加
--   2. suffix_hash を NULL 許容にする
--      （NFCには「末尾6桁」に相当する概念が無い。手入力照合はバーコード専用）

CREATE TABLE wc_checkins_new (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  member_hash TEXT,
  suffix_hash TEXT,
  method TEXT NOT NULL CHECK (method IN ('scan', 'manual', 'nfc')),
  checked_in_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO wc_checkins_new
  (id, event_id, member_hash, suffix_hash, method, checked_in_at, device_id, received_at)
SELECT id, event_id, member_hash, suffix_hash, method, checked_in_at, device_id, received_at
FROM wc_checkins;

DROP TABLE wc_checkins;
ALTER TABLE wc_checkins_new RENAME TO wc_checkins;

-- 端末をまたいだ重複防止。NFCも member_hash に仮名が入るため同じ制約で効く
CREATE UNIQUE INDEX idx_wc_checkins_event_member
  ON wc_checkins(event_id, member_hash)
  WHERE member_hash IS NOT NULL;

-- 手入力（末尾6桁のみ）の端末間重複抑止。NFC・スキャンには適用されない
CREATE UNIQUE INDEX idx_wc_checkins_event_suffix_manual
  ON wc_checkins(event_id, suffix_hash)
  WHERE method = 'manual';

CREATE INDEX idx_wc_checkins_event ON wc_checkins(event_id);
CREATE INDEX idx_wc_checkins_received ON wc_checkins(received_at);
