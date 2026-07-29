-- Migration 0001: scans テーブル
CREATE TABLE scans (
  uuid TEXT PRIMARY KEY,
  wester_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  event TEXT,
  location TEXT,
  session_id TEXT,
  device_id TEXT,
  received_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_scans_event ON scans(event);
CREATE INDEX idx_scans_scanned_at ON scans(scanned_at);
