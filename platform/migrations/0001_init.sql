-- Migration 0001: 交通行動データ収集基盤の初期スキーマ
--
-- 設計の中心は「受信した事実」と「解釈結果」の分離。
--   受信した事実 : read_sessions + raw_observations （不変。絶対に消さない）
--   解釈結果     : derived_transactions （parser_version 付き。いつでも全消し→再生成）
--
-- 将来 HealthKit / GPS / アンケート / InBody / 気象 / GTFS を同じ
-- participant_id × timestamp 系に載せるため、被験者テーブルを最初から独立させる。

-- 被験者。今は1人だが最初から複数前提
CREATE TABLE participants (
  participant_id TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL
);

-- カード仮名と被験者の対応表。
-- card_pseudonym は端末内 HMAC で生成されるため、アプリ再インストールや
-- 機種変更で「同一カードでも値が変わる」。よって 1被験者に複数 pseudonym が
-- 紐づく状態が正常系。UNIQUE 制約は participant_id 側には張らない。
CREATE TABLE participant_cards (
  card_pseudonym TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(participant_id),
  device_id TEXT,
  first_seen_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX idx_cards_participant ON participant_cards(participant_id);

-- 1回の読取セッション
CREATE TABLE read_sessions (
  session_id TEXT PRIMARY KEY,        -- クライアント生成のUUID（転送の冪等キー）
  card_pseudonym TEXT NOT NULL,
  device_id TEXT,
  read_at TEXT NOT NULL,              -- 端末が付与した読取時刻（ISO8601 +09:00）
  received_at TEXT NOT NULL,          -- サーバ受信時刻（UTC ISO8601）
  record_count INTEGER NOT NULL,
  client_version TEXT
);
CREATE INDEX idx_sessions_card ON read_sessions(card_pseudonym, received_at);

-- 生データ。絶対に捨てない。
-- 同じ raw_hex が何度届いても、届いた回数だけ行が増えるのが正しい状態。
CREATE TABLE raw_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES read_sessions(session_id),
  block_order INTEGER NOT NULL,       -- そのセッション内での読出順（0..19）
  raw_hex TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_raw_session ON raw_observations(session_id);

-- 解釈結果。いつでも全削除→再生成できる（= このテーブルは一次情報ではない）
CREATE TABLE derived_transactions (
  transaction_key TEXT PRIMARY KEY,   -- "{card_pseudonym}:{raw_hex}"（src/derive.ts 参照）
  card_pseudonym TEXT NOT NULL,
  used_date TEXT,
  proc_type INTEGER,
  entry_station_code TEXT,            -- "AA-LL-SS"（area-line-station の2桁大文字HEX）
  exit_station_code TEXT,
  balance INTEGER,
  amount_estimated INTEGER,           -- 直前レコードとの残額差分（推定値）
  source_raw_hex TEXT NOT NULL,
  first_session_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  derived_at TEXT NOT NULL
);
CREATE INDEX idx_derived_card_date ON derived_transactions(card_pseudonym, used_date);

-- 駅コードマスタ（近畿圏優先、未収載はコードをそのまま表示）
CREATE TABLE station_master (
  area_code TEXT NOT NULL,
  line_code TEXT NOT NULL,
  station_code TEXT NOT NULL,
  company_name TEXT,
  line_name TEXT,
  station_name TEXT,
  PRIMARY KEY (area_code, line_code, station_code)
);
