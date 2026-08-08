-- Migration 0002: webapp（WESTER来場チェックイン）の同期用テーブル
--
-- 0001 の scans は iOS アプリ用（生の12桁を保存）。webapp は方針が異なり
-- 「会員IDの生値を保存しない」ため、別テーブルとして分離する。
-- webapp が送るのはイベントごとのソルト付き SHA-256 ハッシュのみ。

CREATE TABLE wc_events (
  id TEXT PRIMARY KEY,              -- クライアント生成UUID（冪等キー）
  name TEXT NOT NULL,
  event_date TEXT NOT NULL,         -- YYYY-MM-DD
  venue TEXT NOT NULL,
  device_id TEXT NOT NULL,          -- 作成元端末
  created_at TEXT NOT NULL,         -- ISO8601
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ソルトは同期しない。ソルトを持つのは作成端末のみで、サーバにはハッシュしか
-- 渡らない。他端末は同じイベントで同じソルトを使う必要があるため、
-- イベント共有時にソルトを端末間で受け渡す（招待コード方式。別途対応）。

CREATE TABLE wc_checkins (
  id TEXT PRIMARY KEY,              -- クライアント生成UUID（冪等キー）
  event_id TEXT NOT NULL,
  member_hash TEXT,                 -- scan時のみ。manual時はNULL
  suffix_hash TEXT NOT NULL,        -- 末尾6桁の照合キー
  method TEXT NOT NULL CHECK (method IN ('scan', 'manual')),
  checked_in_at TEXT NOT NULL,      -- ISO8601
  device_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 端末をまたいだ重複チェックインの防止。
-- 同一イベント内で同じ member_hash は1件だけ。複数端末が同じ来場者を
-- 読み取った場合、後着は INSERT OR IGNORE で捨てられる。
-- member_hash が NULL（手入力）の行は SQLite の仕様上この制約に縛られない。
CREATE UNIQUE INDEX idx_wc_checkins_event_member
  ON wc_checkins(event_id, member_hash)
  WHERE member_hash IS NOT NULL;

-- 手入力（末尾6桁のみ）も端末間で重複を抑止する。
-- 末尾6桁は衝突しうるため、運用上は「同一人物の可能性」を示す弱い制約として扱う。
CREATE UNIQUE INDEX idx_wc_checkins_event_suffix_manual
  ON wc_checkins(event_id, suffix_hash)
  WHERE method = 'manual';

-- 増分取得（?since=）用
CREATE INDEX idx_wc_checkins_event ON wc_checkins(event_id);
CREATE INDEX idx_wc_checkins_received ON wc_checkins(received_at);

CREATE TABLE wc_scan_errors (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('duplicate', 'invalid_format')),
  member_hash TEXT,
  suffix_hash TEXT,
  symbology TEXT,
  occurred_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_wc_scan_errors_event ON wc_scan_errors(event_id);
CREATE INDEX idx_wc_scan_errors_received ON wc_scan_errors(received_at);
