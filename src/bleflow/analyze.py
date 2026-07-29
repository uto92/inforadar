"""分析: DuckDB の detections/sessions から集計・補正・OD 突合・精度検証を行う。

出力:
- output/analysis/*.csv          … 人間/他ツール向けの集計CSV
- output/analysis/report_data.json … report(ダッシュボード)が読む全データ

注意:
- ユニーク数は「ハッシュMACのユニーク数」。MAC ランダム化の影響で実人数より
  5〜15% 多めに出るため、randomization_correction(デフォルト 0.9)を乗じた
  補正値を併記する。
- 通過/滞留はセッション単位の分類(1人が複数セッションを持ち得る)。
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np
import polars as pl

from .config import JST, ensure_dir, parse_jst

DURATION_EDGES = [0, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 10**9]
DURATION_LABELS = [
    "0–10秒", "10–30秒", "30–60秒", "1–2分", "2–5分",
    "5–10分", "10–20分", "20–30分", "30–60分", "60分+",
]
RSSI_EDGES = list(range(-100, -25, 5))  # -100 〜 -30 dBm、5dBm 刻み
CLASS_ORDER = ["transit", "uncertain", "dwell"]
TYPE_ORDER = ["A", "G", "S", "O"]


# ── DB 読み込み ────────────────────────────────────────────
def _to_jst(df: pl.DataFrame, cols: list[str]) -> pl.DataFrame:
    for c in cols:
        if c in df.columns and isinstance(df.schema[c], pl.Datetime):
            if df.schema[c].time_zone is None:
                df = df.with_columns(pl.col(c).dt.replace_time_zone("UTC"))
            df = df.with_columns(pl.col(c).dt.convert_time_zone("Asia/Tokyo"))
    return df


def load_db(settings: dict) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame, dict]:
    db_path = Path(settings["paths"]["db"])
    if not db_path.exists():
        raise FileNotFoundError(f"DB がありません: {db_path}。先に `bleflow ingest` を実行してください。")
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        con.execute("SET TimeZone='Asia/Tokyo'")
        detections = pl.from_arrow(con.execute("SELECT * FROM detections").arrow())
        sessions = pl.from_arrow(con.execute("SELECT * FROM sessions").arrow())
        deployments = pl.from_arrow(con.execute("SELECT * FROM deployments").arrow())
        # ingested_at(TIMESTAMPTZ)は fetch すると pytz を要求するため必要列のみ取得
        info_row = con.execute(
            "SELECT synthetic, session_gap_sec, mac_hash_len FROM ingest_info"
        ).fetchone()
    finally:
        con.close()
    info = (
        dict(zip(["synthetic", "session_gap_sec", "mac_hash_len"], info_row))
        if info_row
        else {"synthetic": False}
    )
    detections = _to_jst(detections, ["ts"])
    sessions = _to_jst(sessions, ["first_seen", "last_seen"])
    deployments = _to_jst(deployments, ["start_time"])
    return detections, sessions, deployments, info


# ── 個別ロジック(テスト対象)───────────────────────────────
def classify_sessions(sessions: pl.DataFrame, transit_max_sec: int, dwell_min_sec: int) -> pl.DataFrame:
    """duration < transit_max → transit / >= dwell_min → dwell / 中間 → uncertain。"""
    return sessions.with_columns(
        pl.when(pl.col("duration_sec") < transit_max_sec)
        .then(pl.lit("transit"))
        .when(pl.col("duration_sec") >= dwell_min_sec)
        .then(pl.lit("dwell"))
        .otherwise(pl.lit("uncertain"))
        .alias("class")
    )


def bin_counts(detections: pl.DataFrame, minutes: int) -> pl.DataFrame:
    """ビンごとのユニークデバイス数・延べ検出数(センサー別)。"""
    return (
        detections.with_columns(pl.col("ts").dt.truncate(f"{minutes}m").alias("bin_start"))
        .group_by(["sensor_id", "bin_start"])
        .agg(
            pl.col("mac_hash").n_unique().cast(pl.Int64).alias("unique_devices"),
            pl.len().cast(pl.Int64).alias("detections"),
        )
        .sort(["sensor_id", "bin_start"])
    )


def od_pairs(sessions: pl.DataFrame, max_gap_min: int) -> pl.DataFrame:
    """同一ハッシュのセッションを first_seen 順に並べ、隣接する異センサー間を OD ペアとして数える。

    ギャップ(前の last_seen → 次の first_seen)が max_gap_min 以内のものだけ数える。
    同一センサーの連続セッションはチェーンを切らずに読み飛ばす。
    """
    if len(sessions) == 0:
        return pl.DataFrame(
            schema={"from_sensor": pl.String, "to_sensor": pl.String, "count": pl.Int64}
        )
    s = sessions.sort(["mac_hash", "first_seen"]).with_columns(
        pl.col("sensor_id").shift(-1).over("mac_hash").alias("_next_sensor"),
        pl.col("first_seen").shift(-1).over("mac_hash").alias("_next_first"),
    )
    pairs = s.filter(
        pl.col("_next_sensor").is_not_null()
        & (pl.col("_next_sensor") != pl.col("sensor_id"))
        & ((pl.col("_next_first") - pl.col("last_seen")) <= pl.duration(minutes=max_gap_min))
    )
    return (
        pairs.group_by(
            pl.col("sensor_id").alias("from_sensor"),
            pl.col("_next_sensor").alias("to_sensor"),
        )
        .agg(pl.len().cast(pl.Int64).alias("count"))
        .sort(["from_sensor", "to_sensor"])
    )


def hourly_unique(detections: pl.DataFrame, correction: float) -> pl.DataFrame:
    h = bin_counts(detections, 60).rename({"bin_start": "hour_start", "unique_devices": "unique_raw"})
    return h.with_columns(
        (pl.col("unique_raw") * correction).round(1).alias("unique_corrected")
    ).drop("detections")


def accuracy_vs_truth(hourly: pl.DataFrame, truth: pl.DataFrame) -> dict:
    """時間帯×センサーの補正後ユニーク数を ground truth と比較する。

    真値加重 MAPE(=WAPE): sum(|est - true|) / sum(true)。真値0の時間帯は分子にのみ寄与。
    """
    joined = truth.join(hourly, on=["sensor_id", "hour_start"], how="left").with_columns(
        pl.col("unique_raw").fill_null(0),
        pl.col("unique_corrected").fill_null(0.0),
    )
    joined = joined.with_columns(
        pl.when(pl.col("true_unique_persons") > 0)
        .then(
            (pl.col("unique_corrected") - pl.col("true_unique_persons"))
            / pl.col("true_unique_persons")
            * 100
        )
        .otherwise(None)
        .round(1)
        .alias("err_pct")
    )
    total_true = int(joined["true_unique_persons"].sum())
    total_corrected = float(joined["unique_corrected"].sum())
    total_raw = int(joined["unique_raw"].sum())
    abs_err = (joined["unique_corrected"] - joined["true_unique_persons"]).abs().sum()
    wape = float(abs_err) / total_true * 100 if total_true else 0.0
    return {
        "rows": joined.sort(["sensor_id", "hour_start"]),
        "weighted_mape_pct": round(wape, 2),
        "total_true": total_true,
        "total_raw": total_raw,
        "total_corrected": round(total_corrected, 1),
        "total_err_pct": round((total_corrected - total_true) / total_true * 100, 2)
        if total_true
        else 0.0,
        "pass_15": wape <= 15.0,
    }


def _hist(values: np.ndarray, edges: list[float]) -> list[int]:
    counts, _ = np.histogram(values, bins=np.asarray(edges, dtype=float))
    return [int(c) for c in counts]


# ── メイン ────────────────────────────────────────────────
def _label_range(start: datetime, end: datetime, minutes: int) -> list[datetime]:
    out, cur = [], start
    step = timedelta(minutes=minutes)
    while cur <= end:
        out.append(cur)
        cur += step
    return out


def _series_by_sensor(
    binned: pl.DataFrame, sensor_ids: list[str], labels: list[datetime], value_col: str
) -> dict[str, list]:
    lookup: dict[tuple[str, datetime], int | float] = {
        (r["sensor_id"], r["bin_start"]): r[value_col] for r in binned.iter_rows(named=True)
    }
    return {
        sid: [lookup.get((sid, t), 0) for t in labels] for sid in sensor_ids
    }


def load_ground_truth(settings: dict) -> tuple[pl.DataFrame | None, pl.DataFrame | None]:
    synth_dir = Path(settings["paths"]["synth_dir"])
    hourly_p = synth_dir / "ground_truth.csv"
    od_p = synth_dir / "ground_truth_od.csv"
    truth_hourly = truth_od = None
    if hourly_p.exists():
        t = pl.read_csv(hourly_p)
        hours = [parse_jst(s) for s in t["hour_start"].to_list()]
        truth_hourly = t.drop("hour_start").with_columns(
            pl.Series("hour_start", hours, dtype=pl.Datetime("us", "Asia/Tokyo"))
        )
    if od_p.exists():
        truth_od = pl.read_csv(od_p)
    return truth_hourly, truth_od


def run_analyze(settings: dict) -> dict:
    acfg = settings["analyze"]
    detections, sessions, deployments, info = load_db(settings)
    synthetic = bool(info.get("synthetic", False))
    correction = float(acfg["randomization_correction"])

    sensor_ids = deployments["sensor_id"].to_list()
    out_dir = ensure_dir(Path(settings["paths"]["output_dir"]) / "analysis")

    # ── ビン集計(5分/15分)────────────────────────────────
    t_min = detections["ts"].min()
    t_max = detections["ts"].max()
    bins_data: dict[str, dict] = {}
    for minutes in acfg["bin_minutes"]:
        minutes = int(minutes)
        b = bin_counts(detections, minutes)
        b.rename({"bin_start": "bin_start"}).write_csv(out_dir / f"bin_counts_{minutes}min.csv")
        start = t_min.replace(second=0, microsecond=0)
        start -= timedelta(minutes=start.minute % minutes)
        labels = _label_range(start, t_max, minutes)
        bins_data[str(minutes)] = {
            "labels": [t.isoformat() for t in labels],
            "unique": _series_by_sensor(b, sensor_ids, labels, "unique_devices"),
            "detections": _series_by_sensor(b, sensor_ids, labels, "detections"),
        }

    # ── 時間帯別ユニーク(生+補正)─────────────────────────
    hourly = hourly_unique(detections, correction)
    hourly.write_csv(out_dir / "hourly_unique.csv")
    hour_start0 = t_min.replace(minute=0, second=0, microsecond=0)
    hour_labels = _label_range(hour_start0, t_max, 60)
    hourly_data = {
        "hours": [t.isoformat() for t in hour_labels],
        "raw": _series_by_sensor(
            hourly.rename({"hour_start": "bin_start"}), sensor_ids, hour_labels, "unique_raw"
        ),
        "corrected": _series_by_sensor(
            hourly.rename({"hour_start": "bin_start"}), sensor_ids, hour_labels, "unique_corrected"
        ),
    }

    # ── 通過/滞留(セッション分類)─────────────────────────
    classified = classify_sessions(
        sessions, int(acfg["transit_max_sec"]), int(acfg["dwell_min_sec"])
    )
    class_counts = (
        classified.group_by(["sensor_id", "class"]).agg(pl.len().alias("n_sessions"))
        .sort(["sensor_id", "class"])
    )
    class_counts.with_columns(
        (pl.col("n_sessions") / pl.col("n_sessions").sum().over("sensor_id")).round(4).alias("share")
    ).write_csv(out_dir / "session_classes.csv")
    class_lookup = {
        (r["sensor_id"], r["class"]): r["n_sessions"] for r in class_counts.iter_rows(named=True)
    }
    classes_data = {
        "sensors": sensor_ids,
        **{
            cls: [int(class_lookup.get((sid, cls), 0)) for sid in sensor_ids]
            for cls in CLASS_ORDER
        },
    }

    # ── デバイス種別(ユニークハッシュ基準)─────────────────
    type_overall = {
        r["dev_type"]: r["n"]
        for r in detections.group_by("dev_type")
        .agg(pl.col("mac_hash").n_unique().alias("n"))
        .iter_rows(named=True)
    }
    type_per_sensor = {
        sid: {t: 0 for t in TYPE_ORDER} for sid in sensor_ids
    }
    for r in (
        detections.group_by(["sensor_id", "dev_type"])
        .agg(pl.col("mac_hash").n_unique().alias("n"))
        .iter_rows(named=True)
    ):
        type_per_sensor[r["sensor_id"]][r["dev_type"]] = int(r["n"])
    type_rows = [
        {"scope": "overall", "sensor_id": "", "dev_type": t, "unique_devices": int(type_overall.get(t, 0))}
        for t in TYPE_ORDER
    ] + [
        {"scope": "sensor", "sensor_id": sid, "dev_type": t, "unique_devices": type_per_sensor[sid][t]}
        for sid in sensor_ids
        for t in TYPE_ORDER
    ]
    pl.DataFrame(type_rows).write_csv(out_dir / "device_type_share.csv")

    # 母集団補正の参考値: iOS シェア比較と可視端末率による粗い推定
    a = type_overall.get("A", 0)
    gs = type_overall.get("G", 0) + type_overall.get("S", 0)
    observed_ios_share = round(a / (a + gs), 3) if (a + gs) else None
    unique_all = int(detections["mac_hash"].n_unique())
    corrected_all = unique_all * correction
    detectable_rate = float(acfg["detectable_rate"])
    population = {
        "unique_devices_all": unique_all,
        "corrected_devices_all": round(corrected_all, 1),
        "observed_ios_share": observed_ios_share,
        "expected_ios_share": float(acfg["expected_ios_share"]),
        "detectable_rate": detectable_rate,
        # TODO: 実データでの目視カウント調査により detectable_rate を較正する
        "est_total_pedestrians": round(corrected_all / detectable_rate) if detectable_rate else None,
    }

    # ── RSSI / セッション長の分布 ───────────────────────────
    rssi_hist = {
        sid: _hist(
            detections.filter(pl.col("sensor_id") == sid)["rssi"].to_numpy(), RSSI_EDGES
        )
        for sid in sensor_ids
    }
    duration_hist = {
        sid: _hist(
            classified.filter(pl.col("sensor_id") == sid)["duration_sec"].to_numpy(),
            DURATION_EDGES,
        )
        for sid in sensor_ids
    }

    # ── OD 突合(Phase 2 先行実装)──────────────────────────
    od = od_pairs(sessions, int(acfg["od_max_gap_min"]))
    truth_hourly, truth_od = (None, None)
    if synthetic:
        truth_hourly, truth_od = load_ground_truth(settings)
    od_lookup = {(r["from_sensor"], r["to_sensor"]): r["count"] for r in od.iter_rows(named=True)}
    od_matrix = [
        [int(od_lookup.get((a_, b_), 0)) for b_ in sensor_ids] for a_ in sensor_ids
    ]
    od_csv = od.rename({"count": "count"})
    truth_matrix = None
    if truth_od is not None:
        t_lookup = {
            (r["from_sensor"], r["to_sensor"]): r["true_count"] for r in truth_od.iter_rows(named=True)
        }
        truth_matrix = [
            [int(t_lookup.get((a_, b_), 0)) for b_ in sensor_ids] for a_ in sensor_ids
        ]
        od_csv = od_csv.join(
            truth_od.rename({"from_sensor": "from_sensor", "to_sensor": "to_sensor"}),
            on=["from_sensor", "to_sensor"],
            how="full",
            coalesce=True,
        ).fill_null(0)
    od_csv.write_csv(out_dir / "od_matrix.csv")
    od_data = {
        "sensors": sensor_ids,
        "matrix": od_matrix,
        "total": int(sum(sum(r) for r in od_matrix)),
        "truth": truth_matrix,
        "truth_total": int(sum(sum(r) for r in truth_matrix)) if truth_matrix else None,
    }

    # ── 精度検証(synthetic のみ)───────────────────────────
    accuracy = None
    if truth_hourly is not None:
        acc = accuracy_vs_truth(hourly, truth_hourly)
        rows: pl.DataFrame = acc.pop("rows")
        rows.write_csv(out_dir / "accuracy_hourly.csv")
        accuracy = {
            **acc,
            "hourly": [
                {
                    "hour_start": r["hour_start"].isoformat(),
                    "sensor_id": r["sensor_id"],
                    "true": int(r["true_unique_persons"]),
                    "raw": int(r["unique_raw"]),
                    "corrected": float(r["unique_corrected"]),
                    "err_pct": r["err_pct"],
                }
                for r in rows.iter_rows(named=True)
            ],
        }
    elif synthetic:
        print("[analyze] 警告: synthetic データですが ground truth が見つかりません(精度検証スキップ)")

    # ── センサーサマリー / マップ ───────────────────────────
    ses_stats = {
        r["sensor_id"]: r
        for r in sessions.group_by("sensor_id")
        .agg(pl.len().alias("n_sessions"))
        .iter_rows(named=True)
    }
    det_stats = {
        r["sensor_id"]: r
        for r in detections.group_by("sensor_id")
        .agg(pl.len().alias("n_detections"), pl.col("mac_hash").n_unique().alias("unique"))
        .iter_rows(named=True)
    }
    sensors_data = []
    for d in deployments.iter_rows(named=True):
        sid = d["sensor_id"]
        u = int(det_stats.get(sid, {}).get("unique", 0))
        sensors_data.append(
            {
                "sensor_id": sid,
                "location_name": d["location_name"],
                "lat": d["lat"],
                "lon": d["lon"],
                "start_time": d["start_time"].isoformat() if d["start_time"] else None,
                "method": d["method"],
                "n_detections": int(det_stats.get(sid, {}).get("n_detections", 0)),
                "n_sessions": int(ses_stats.get(sid, {}).get("n_sessions", 0)),
                "unique_devices": u,
                "unique_corrected": round(u * correction, 1),
            }
        )
    map_sensors = [s for s in sensors_data if s["lat"] is not None and s["lon"] is not None]

    data = {
        "generated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "title": settings["report"]["title"],
        "mode": "synthetic" if synthetic else "real",
        "period": {"start": t_min.isoformat(), "end": t_max.isoformat()},
        "totals": {
            "detections": int(len(detections)),
            "sessions": int(len(sessions)),
            "unique_devices": unique_all,
            "unique_corrected": round(corrected_all, 1),
        },
        "sensors": sensors_data,
        "bins": bins_data,
        "hourly": hourly_data,
        "classes": classes_data,
        "device_types": {
            "overall": {t: int(type_overall.get(t, 0)) for t in TYPE_ORDER},
            "per_sensor": type_per_sensor,
        },
        "rssi_hist": {"edges": RSSI_EDGES, "per_sensor": rssi_hist},
        "duration_hist": {"labels": DURATION_LABELS, "per_sensor": duration_hist},
        "od": od_data,
        "map": {"sensors": map_sensors} if map_sensors else None,
        "accuracy": accuracy,
        "population": population,
        "params": {
            "session_gap_sec": int(info.get("session_gap_sec", settings["ingest"]["session_gap_sec"])),
            "transit_max_sec": int(acfg["transit_max_sec"]),
            "dwell_min_sec": int(acfg["dwell_min_sec"]),
            "randomization_correction": correction,
            "od_max_gap_min": int(acfg["od_max_gap_min"]),
        },
    }

    json_path = out_dir / "report_data.json"
    json_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8"
    )

    # ── サマリー表示 ───────────────────────────────────────
    n_transit = sum(classes_data["transit"])
    n_dwell = sum(classes_data["dwell"])
    n_unc = sum(classes_data["uncertain"])
    print(
        f"[analyze] 期間 {data['period']['start']} 〜 {data['period']['end']}"
        f"({'synthetic' if synthetic else 'real'})"
    )
    print(
        f"[analyze] ユニークデバイス {unique_all:,}(補正後 {corrected_all:,.0f})/ "
        f"セッション {len(sessions):,} = 通過 {n_transit:,}・不定 {n_unc:,}・滞留 {n_dwell:,}"
    )
    print(f"[analyze] OD ペア総数 {od_data['total']:,}(15分以内の隣接遷移)")
    if accuracy:
        print(
            f"[analyze] 精度: 真値加重MAPE {accuracy['weighted_mape_pct']:.1f}% / "
            f"日合計誤差 {accuracy['total_err_pct']:+.1f}% "
            f"({'PASS' if accuracy['pass_15'] else 'FAIL'}: 目標±15%)"
        )
    print(f"[analyze] 出力: {out_dir}/(report_data.json ほか)")
    return data
