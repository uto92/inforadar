"""ingest のテスト。

仕様上必須のテスト対象:
- 実時刻変換(start_time + elapsed_sec、JST tz-aware)
- セッション化(ギャップ > 30秒 で分割、ちょうど30秒は同一セッション)
それに加えて MAC ハッシュ化(プライバシー原則)を検証する。
"""

from __future__ import annotations

from datetime import datetime

import polars as pl
import pytest

from bleflow.config import JST, parse_jst
from bleflow.ingest import attach_real_time, hash_mac, hash_macs, read_raw_csv, sessionize


# ── 実時刻変換 ─────────────────────────────────────────────
def test_attach_real_time_jst():
    start = parse_jst("2026-08-01T07:30:00+09:00")
    df = pl.DataFrame({"elapsed_sec": [0, 1, 3600]})
    out = attach_real_time(df, start)

    assert out["ts"].dtype == pl.Datetime("us", "Asia/Tokyo")
    ts = out["ts"].to_list()
    assert ts[0] == datetime(2026, 8, 1, 7, 30, 0, tzinfo=JST)
    assert ts[1] == datetime(2026, 8, 1, 7, 30, 1, tzinfo=JST)
    assert ts[2] == datetime(2026, 8, 1, 8, 30, 0, tzinfo=JST)


def test_attach_real_time_crosses_midnight():
    start = parse_jst("2026-08-01T23:50:00+09:00")
    out = attach_real_time(pl.DataFrame({"elapsed_sec": [1200]}), start)
    assert out["ts"][0] == datetime(2026, 8, 2, 0, 10, 0, tzinfo=JST)


def test_attach_real_time_accepts_non_jst_offset():
    # UTC 表記の start_time でも JST に正規化される
    start = parse_jst("2026-07-31T22:30:00+00:00")  # = 2026-08-01 07:30 JST
    out = attach_real_time(pl.DataFrame({"elapsed_sec": [0]}), start)
    assert out["ts"][0] == datetime(2026, 8, 1, 7, 30, 0, tzinfo=JST)


# ── MAC ハッシュ化 ────────────────────────────────────────
def test_hash_mac_properties():
    salt = "test-salt"
    h1 = hash_mac("4A:BB:CC:DD:EE:01", salt)
    assert len(h1) == 16
    assert h1 == hash_mac("4a:bb:cc:dd:ee:01", salt)  # 大文字小文字を正規化
    assert h1 != hash_mac("4A:BB:CC:DD:EE:02", salt)  # 別MACは別ハッシュ
    assert h1 != hash_mac("4A:BB:CC:DD:EE:01", "other-salt")  # ソルト依存


def test_hash_macs_removes_raw_mac():
    df = pl.DataFrame({"mac": ["4A:BB:CC:DD:EE:01"], "rssi": [-60]})
    out = hash_macs(df, "s")
    assert "mac" not in out.columns
    assert "4A:BB:CC:DD:EE:01" not in str(out.to_dicts())


# ── セッション化 ──────────────────────────────────────────
def _detections(rows: list[tuple[str, str, int, int]]) -> pl.DataFrame:
    """(sensor, hash, 秒, rssi) から検出 DataFrame を作る。"""
    start = parse_jst("2026-08-01T10:00:00+09:00")
    df = pl.DataFrame(
        {
            "sensor_id": [r[0] for r in rows],
            "mac_hash": [r[1] for r in rows],
            "elapsed_sec": [r[2] for r in rows],
            "rssi": [r[3] for r in rows],
            "dev_type": ["A"] * len(rows),
        }
    )
    return attach_real_time(df, start)


def test_sessionize_splits_on_gap_over_30s():
    det = _detections(
        [
            ("S1", "x", 0, -60),
            ("S1", "x", 10, -70),
            ("S1", "x", 20, -65),
            ("S1", "x", 55, -80),   # ギャップ35秒 > 30 → 新セッション
            ("S1", "x", 56, -82),
            ("S1", "x", 300, -90),  # ギャップ244秒 → 新セッション
        ]
    )
    ses = sessionize(det, gap_sec=30).sort("first_seen")
    assert len(ses) == 3
    assert ses["duration_sec"].to_list() == [20, 1, 0]
    assert ses["n_detections"].to_list() == [3, 2, 1]
    first = ses.row(0, named=True)
    assert first["avg_rssi"] == -65.0
    assert first["max_rssi"] == -60
    assert first["first_seen"] == datetime(2026, 8, 1, 10, 0, 0, tzinfo=JST)
    assert first["last_seen"] == datetime(2026, 8, 1, 10, 0, 20, tzinfo=JST)


def test_sessionize_gap_exactly_30s_stays_together():
    det = _detections([("S1", "x", 0, -60), ("S1", "x", 30, -61), ("S1", "x", 61, -62)])
    # 30秒差は同一セッション、31秒差で分割
    ses = sessionize(det, gap_sec=30)
    assert len(ses) == 2
    assert ses.sort("first_seen")["n_detections"].to_list() == [2, 1]


def test_sessionize_is_per_sensor_and_per_hash():
    det = _detections(
        [
            ("S1", "x", 0, -60),
            ("S2", "x", 5, -60),   # 同一hashでも別センサーは別セッション
            ("S1", "y", 8, -60),   # 別hashは別セッション
            ("S1", "x", 10, -60),
        ]
    )
    ses = sessionize(det, gap_sec=30)
    assert len(ses) == 3
    s1x = ses.filter((pl.col("sensor_id") == "S1") & (pl.col("mac_hash") == "x"))
    assert s1x["n_detections"][0] == 2


def test_sessionize_empty():
    ses = sessionize(_detections([]).head(0), gap_sec=30)
    assert len(ses) == 0


# ── 生CSV読み込みのクリーニング ─────────────────────────────
def test_read_raw_csv_cleaning(tmp_path):
    p = tmp_path / "raw.csv"
    p.write_text(
        "elapsed_sec,mac,rssi,type\n"
        "10,AA:AA:AA:AA:AA:01,-60,A\n"
        "10,AA:AA:AA:AA:AA:01,-60,A\n"   # 完全重複 → 除去
        "-5,AA:AA:AA:AA:AA:02,-60,G\n"   # 負の elapsed → 除去
        "11,AA:AA:AA:AA:AA:03,5,S\n"     # 正の rssi → 除去
        "12,AA:AA:AA:AA:AA:04,-70,x\n",  # 未知 type → O に正規化
        encoding="utf-8",
    )
    df, dropped = read_raw_csv(p)
    assert dropped == 3
    assert len(df) == 2
    assert df.filter(pl.col("mac") == "AA:AA:AA:AA:AA:04")["type"][0] == "O"
