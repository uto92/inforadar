"""取り込み: センサー生CSV → DuckDB(detections / sessions / deployments)。

プライバシー原則(CLAUDE.md §プライバシー):
- 生 MAC はこのモジュール内で読み込み直後にソルト付き SHA-256 へハッシュ化し、
  DB・戻り値・ログには一切残さない。
- ソルトは config/salt.txt(gitignore 対象)。無ければ自動生成する。

実時刻変換: センサーに RTC が無いため、ts = start_time(deployments.yaml)+ elapsed_sec。
セッション化: 同一 (sensor_id, mac_hash) の連続検出を、検出間ギャップ > session_gap_sec
で分割して 1 セッション = 1 レコードに集約する(ちょうど gap 秒は同一セッション)。
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import polars as pl

from .config import ensure_dir, load_deployments, load_or_create_salt

RAW_SCHEMA = {"elapsed_sec": pl.Int64, "mac": pl.String, "rssi": pl.Int64, "type": pl.String}
VALID_TYPES = {"A", "G", "S", "O"}


def hash_mac(mac: str, salt: str, length: int = 16) -> str:
    """MAC をソルト付き SHA-256 でハッシュ化し先頭 length hex を返す。"""
    normalized = mac.strip().upper()
    return hashlib.sha256(f"{salt}:{normalized}".encode()).hexdigest()[:length]


def read_raw_csv(path: str | Path) -> tuple[pl.DataFrame, int]:
    """生CSVを読み、(有効行, 除外行数) を返す。列不足はエラー。"""
    p = Path(path)
    df = pl.read_csv(p, schema_overrides=RAW_SCHEMA)
    missing = [c for c in RAW_SCHEMA if c not in df.columns]
    if missing:
        raise ValueError(f"{p}: 必須列がありません: {missing}(elapsed_sec,mac,rssi,type が必要)")
    df = df.select(list(RAW_SCHEMA))
    n_before = len(df)
    df = (
        df.drop_nulls(["elapsed_sec", "mac", "rssi"])
        .filter(
            (pl.col("elapsed_sec") >= 0)
            & (pl.col("rssi") <= 0)
            & (pl.col("rssi") >= -120)
            & (pl.col("mac").str.len_chars() > 0)
        )
        .with_columns(
            # type は A/G/S/O 以外を O に寄せる(ファーム更新等でコード が増えても壊さない)
            pl.col("type").str.strip_chars().str.to_uppercase().str.slice(0, 1)
            .map_elements(lambda t: t if t in VALID_TYPES else "O", return_dtype=pl.String)
            .alias("type")
        )
        .unique(maintain_order=True)  # 再ダンプ等による完全重複行を除去
    )
    return df, n_before - len(df)


def attach_real_time(df: pl.DataFrame, start_time: datetime) -> pl.DataFrame:
    """elapsed_sec を実時刻(JST tz-aware)に変換した ts 列を付与する。"""
    start_us = int(start_time.astimezone(timezone.utc).timestamp() * 1_000_000)
    return df.with_columns(
        (pl.lit(start_us, dtype=pl.Int64) + pl.col("elapsed_sec") * 1_000_000)
        .cast(pl.Datetime("us"))
        .dt.replace_time_zone("UTC")
        .dt.convert_time_zone("Asia/Tokyo")
        .alias("ts")
    )


def hash_macs(df: pl.DataFrame, salt: str, length: int = 16) -> pl.DataFrame:
    """mac 列をハッシュ化した mac_hash 列に置き換える(生MACはここで消える)。"""
    macs = df["mac"].to_list()
    hashes = [hash_mac(m, salt, length) for m in macs]
    return df.drop("mac").with_columns(pl.Series("mac_hash", hashes, dtype=pl.String))


def sessionize(detections: pl.DataFrame, gap_sec: int) -> pl.DataFrame:
    """検出イベントをセッションへ集約する。

    入力: sensor_id, mac_hash, ts, rssi, dev_type を持つ DataFrame
    出力: sensor_id, mac_hash, dev_type, first_seen, last_seen, duration_sec,
          avg_rssi, max_rssi, n_detections
    """
    if len(detections) == 0:
        return pl.DataFrame(
            schema={
                "sensor_id": pl.String,
                "mac_hash": pl.String,
                "dev_type": pl.String,
                "first_seen": pl.Datetime("us", "Asia/Tokyo"),
                "last_seen": pl.Datetime("us", "Asia/Tokyo"),
                "duration_sec": pl.Int64,
                "avg_rssi": pl.Float64,
                "max_rssi": pl.Int64,
                "n_detections": pl.Int64,
            }
        )
    key = ["sensor_id", "mac_hash"]
    return (
        detections.sort(key + ["ts"])
        .with_columns(
            (
                (pl.col("ts") - pl.col("ts").shift(1).over(key)) > pl.duration(seconds=gap_sec)
            )
            .fill_null(True)
            .cast(pl.Int32)
            .alias("_new_session")
        )
        .with_columns(pl.col("_new_session").cum_sum().over(key).alias("_session_no"))
        .group_by(key + ["_session_no"], maintain_order=True)
        .agg(
            pl.col("dev_type").first(),
            pl.col("ts").min().alias("first_seen"),
            pl.col("ts").max().alias("last_seen"),
            pl.col("rssi").mean().round(1).alias("avg_rssi"),
            pl.col("rssi").max().alias("max_rssi"),
            pl.len().cast(pl.Int64).alias("n_detections"),
        )
        .with_columns(
            (pl.col("last_seen") - pl.col("first_seen"))
            .dt.total_seconds()
            .cast(pl.Int64)
            .alias("duration_sec")
        )
        .drop("_session_no")
        .select(
            "sensor_id",
            "mac_hash",
            "dev_type",
            "first_seen",
            "last_seen",
            "duration_sec",
            "avg_rssi",
            "max_rssi",
            "n_detections",
        )
        .sort(["sensor_id", "first_seen", "mac_hash"])
    )


def run_ingest(settings: dict) -> dict:
    paths = settings["paths"]
    icfg = settings["ingest"]
    meta, deployments = load_deployments(paths["deployments"])
    salt = load_or_create_salt(paths["salt_file"])
    hash_len = int(icfg["mac_hash_len"])
    gap_sec = int(icfg["session_gap_sec"])

    frames: list[pl.DataFrame] = []
    per_sensor: list[dict] = []
    missing_files: list[str] = []
    for dep in deployments:
        p = Path(dep["file"])
        if not p.exists():
            missing_files.append(f"{dep['sensor_id']}: {p}")
            print(f"[ingest] 警告: {dep['sensor_id']} のファイルが見つかりません: {p}(スキップ)")
            continue
        raw, dropped = read_raw_csv(p)
        df = attach_real_time(raw, dep["start_time"])
        df = hash_macs(df, salt, hash_len)
        df = df.select(
            pl.lit(dep["sensor_id"]).alias("sensor_id"),
            "ts",
            "elapsed_sec",
            "mac_hash",
            "rssi",
            pl.col("type").alias("dev_type"),
        )
        frames.append(df)
        per_sensor.append(
            {
                "sensor_id": dep["sensor_id"],
                "rows": len(df),
                "dropped": dropped,
                "unique_hashes": df["mac_hash"].n_unique(),
            }
        )

    if not frames:
        raise FileNotFoundError(
            "取り込めるCSVが1つもありません:\n  " + "\n  ".join(missing_files)
        )

    detections = pl.concat(frames)
    sessions = sessionize(detections, gap_sec)

    deployments_df = pl.DataFrame(
        [
            {
                "sensor_id": d["sensor_id"],
                "location_name": d["location_name"],
                "lat": d["lat"],
                "lon": d["lon"],
                "start_time": d["start_time"],
                "method": d["method"],
                "battery_mah": d["battery_mah"],
                "notes": d["notes"],
                "file": d["file"],
            }
            for d in deployments
        ],
        schema_overrides={"lat": pl.Float64, "lon": pl.Float64, "battery_mah": pl.Int64},
    )

    db_path = Path(paths["db"])
    ensure_dir(db_path.parent)
    con = duckdb.connect(str(db_path))
    try:
        con.execute("SET TimeZone='Asia/Tokyo'")
        det_arrow = detections.to_arrow()
        ses_arrow = sessions.to_arrow()
        dep_arrow = deployments_df.to_arrow()
        con.register("det_arrow", det_arrow)
        con.register("ses_arrow", ses_arrow)
        con.register("dep_arrow", dep_arrow)
        con.execute("CREATE OR REPLACE TABLE detections AS SELECT * FROM det_arrow")
        con.execute("CREATE OR REPLACE TABLE sessions AS SELECT * FROM ses_arrow")
        con.execute("CREATE OR REPLACE TABLE deployments AS SELECT * FROM dep_arrow")
        con.execute(
            "CREATE OR REPLACE TABLE ingest_info AS "
            "SELECT ? AS synthetic, ? AS session_gap_sec, ? AS mac_hash_len, "
            "now() AS ingested_at",
            [meta["synthetic"], gap_sec, hash_len],
        )
    finally:
        con.close()

    stats = {
        "db": str(db_path),
        "synthetic": meta["synthetic"],
        "n_detections": len(detections),
        "n_sessions": len(sessions),
        "per_sensor": per_sensor,
        "missing_files": missing_files,
    }
    for s in per_sensor:
        print(
            f"[ingest]   {s['sensor_id']}: {s['rows']:>7,} 検出 / "
            f"ユニークhash {s['unique_hashes']:>5,} / 除外 {s['dropped']} 行"
        )
    suffix = "(synthetic)" if meta["synthetic"] else ""
    print(
        f"[ingest] {len(per_sensor)} センサー計 {stats['n_detections']:,} 検出 → "
        f"{stats['n_sessions']:,} セッション → {db_path}{suffix}"
    )
    return stats
