"""analyze のテスト: 分類閾値・ビン集計・OD 突合・精度指標。"""

from __future__ import annotations

import polars as pl

from bleflow.analyze import (
    accuracy_vs_truth,
    bin_counts,
    classify_sessions,
    hourly_unique,
    od_pairs,
)
from bleflow.config import parse_jst
from bleflow.ingest import attach_real_time


def _ts(s: str):
    return parse_jst(s)


def _sessions(rows: list[tuple[str, str, str, str]]) -> pl.DataFrame:
    """(sensor, hash, first_seen, last_seen) からセッション DataFrame を作る。"""
    df = pl.DataFrame(
        {
            "sensor_id": [r[0] for r in rows],
            "mac_hash": [r[1] for r in rows],
            "first_seen": [_ts(r[2]) for r in rows],
            "last_seen": [_ts(r[3]) for r in rows],
        },
        schema_overrides={
            "first_seen": pl.Datetime("us", "Asia/Tokyo"),
            "last_seen": pl.Datetime("us", "Asia/Tokyo"),
        },
    )
    return df.with_columns(
        (pl.col("last_seen") - pl.col("first_seen")).dt.total_seconds().alias("duration_sec")
    )


# ── 通過/滞留の分類閾値 ────────────────────────────────────
def test_classify_thresholds():
    df = pl.DataFrame({"duration_sec": [0, 59, 60, 119, 120, 3600]})
    out = classify_sessions(df, transit_max_sec=60, dwell_min_sec=120)
    assert out["class"].to_list() == [
        "transit", "transit", "uncertain", "uncertain", "dwell", "dwell",
    ]


# ── ビン集計 ──────────────────────────────────────────────
def test_bin_counts_unique_and_total():
    start = parse_jst("2026-08-01T10:00:00+09:00")
    det = attach_real_time(
        pl.DataFrame(
            {
                "sensor_id": ["S1"] * 4 + ["S2"],
                "mac_hash": ["a", "a", "b", "a", "c"],
                "elapsed_sec": [10, 20, 30, 310, 10],  # S1: 5分ビン2つに跨がる
            }
        ),
        start,
    )
    out = bin_counts(det, 5)
    s1 = out.filter(pl.col("sensor_id") == "S1").sort("bin_start")
    assert s1["unique_devices"].to_list() == [2, 1]  # 1ビン目 a,b / 2ビン目 a
    assert s1["detections"].to_list() == [3, 1]
    assert out.filter(pl.col("sensor_id") == "S2")["unique_devices"].to_list() == [1]


# ── OD 突合 ──────────────────────────────────────────────
def test_od_pairs_basic_and_gap():
    ses = _sessions(
        [
            # x: S1 → S2(ギャップ4分)→ カウント
            ("S1", "x", "2026-08-01T10:00:00+09:00", "2026-08-01T10:01:00+09:00"),
            ("S2", "x", "2026-08-01T10:05:00+09:00", "2026-08-01T10:06:00+09:00"),
            # y: S1 → S3(ギャップ16分)→ カウントしない
            ("S1", "y", "2026-08-01T10:00:00+09:00", "2026-08-01T10:01:00+09:00"),
            ("S3", "y", "2026-08-01T10:17:00+09:00", "2026-08-01T10:18:00+09:00"),
        ]
    )
    od = od_pairs(ses, max_gap_min=15)
    assert od.to_dicts() == [{"from_sensor": "S1", "to_sensor": "S2", "count": 1}]


def test_od_pairs_same_sensor_does_not_break_chain():
    ses = _sessions(
        [
            ("S1", "x", "2026-08-01T10:00:00+09:00", "2026-08-01T10:01:00+09:00"),
            ("S1", "x", "2026-08-01T10:03:00+09:00", "2026-08-01T10:04:00+09:00"),
            ("S2", "x", "2026-08-01T10:08:00+09:00", "2026-08-01T10:09:00+09:00"),
            ("S3", "x", "2026-08-01T10:12:00+09:00", "2026-08-01T10:13:00+09:00"),
        ]
    )
    od = od_pairs(ses, max_gap_min=15)
    assert {(r["from_sensor"], r["to_sensor"]): r["count"] for r in od.to_dicts()} == {
        ("S1", "S2"): 1,
        ("S2", "S3"): 1,
    }


def test_od_pairs_orders_by_time_and_allows_overlap():
    # 検出時刻順に並ぶこと(入力順ではない)。重なり(負ギャップ)も1遷移として数える
    ses = _sessions(
        [
            ("S2", "x", "2026-08-01T10:05:00+09:00", "2026-08-01T10:06:00+09:00"),
            ("S1", "x", "2026-08-01T10:00:00+09:00", "2026-08-01T10:05:30+09:00"),
        ]
    )
    od = od_pairs(ses, max_gap_min=15)
    assert od.to_dicts() == [{"from_sensor": "S1", "to_sensor": "S2", "count": 1}]


def test_od_pairs_empty():
    assert len(od_pairs(_sessions([]), 15)) == 0


# ── 精度指標(真値加重 MAPE = WAPE)────────────────────────
def test_accuracy_weighted_mape():
    hourly = pl.DataFrame(
        {
            "sensor_id": ["S1", "S1"],
            "hour_start": [_ts("2026-08-01T07:00:00+09:00"), _ts("2026-08-01T08:00:00+09:00")],
            "unique_raw": [110, 90],
            "unique_corrected": [110.0, 90.0],
        },
        schema_overrides={"hour_start": pl.Datetime("us", "Asia/Tokyo")},
    )
    truth = pl.DataFrame(
        {
            "hour_start": [_ts("2026-08-01T07:00:00+09:00"), _ts("2026-08-01T08:00:00+09:00")],
            "sensor_id": ["S1", "S1"],
            "true_unique_persons": [100, 100],
            "true_transit": [100, 100],
            "true_dwell": [0, 0],
        },
        schema_overrides={"hour_start": pl.Datetime("us", "Asia/Tokyo")},
    )
    acc = accuracy_vs_truth(hourly, truth)
    # |110-100| + |90-100| = 20 / 200 = 10%
    assert acc["weighted_mape_pct"] == 10.0
    assert acc["total_true"] == 200
    assert acc["total_err_pct"] == 0.0
    assert acc["pass_15"] is True
    errs = {(r["hour_start"], r["err_pct"]) for r in acc["rows"].iter_rows(named=True)}
    assert {e[1] for e in errs} == {10.0, -10.0}


def test_hourly_unique_correction():
    start = parse_jst("2026-08-01T10:00:00+09:00")
    det = attach_real_time(
        pl.DataFrame(
            {"sensor_id": ["S1"] * 3, "mac_hash": ["a", "b", "c"], "elapsed_sec": [0, 10, 20]}
        ),
        start,
    )
    h = hourly_unique(det, correction=0.9)
    assert h["unique_raw"].to_list() == [3]
    assert h["unique_corrected"].to_list() == [2.7]
