"""設定・deployments の読み込みと共通ユーティリティ。

パスはすべて CWD(リポジトリルートでの実行を想定)からの相対で解決する。
時刻は JST(Asia/Tokyo)の tz-aware datetime で統一する。
"""

from __future__ import annotations

import copy
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

JST = ZoneInfo("Asia/Tokyo")

SYNTH_MARKER = "bleflow-synth"

# settings.yaml が欠けていても動くよう、全キーのデフォルトを持つ
DEFAULTS: dict[str, Any] = {
    "timezone": "Asia/Tokyo",
    "paths": {
        "db": "data/bleflow.duckdb",
        "raw_dir": "data/raw",
        "synth_dir": "data/synth",
        "output_dir": "output",
        "deployments": "config/deployments.yaml",
        "salt_file": "config/salt.txt",
    },
    "ingest": {
        "session_gap_sec": 30,
        "mac_hash_len": 16,
    },
    "analyze": {
        "bin_minutes": [5, 15],
        "transit_max_sec": 60,
        "dwell_min_sec": 120,
        "randomization_correction": 0.9,
        "od_max_gap_min": 15,
        "expected_ios_share": 0.62,
        "detectable_rate": 0.35,
    },
    "report": {
        "file": "output/report.html",
        "title": "ble-flow 人流レポート — 天神橋1丁目",
    },
    "synth": {
        "seed": 20260801,
        "date": "2026-08-01",
        "sim_start": "07:00",
        "sim_end": "21:00",
        "n_persons": 2200,
        "dwell_share": 0.12,
        "dwell_minutes": [30, 90],
        "speed_mps": [1.25, 0.2],
        "mac_rotation_min": [15, 20],
        "fixed_mac_prob": {"A": 0.03, "G": 0.08, "S": 0.15, "O": 0.60},
        "type_shares": {"A": 0.55, "G": 0.25, "S": 0.10, "O": 0.10},
        "rssi": {
            "tx_power_1m": -55,
            "path_loss_exp": 2.8,
            "noise_sd": 3.5,
            "detect_threshold": -94,
        },
        "detect_prob_per_sec": 0.35,
        "coverage_radius_m": 30,
        "area": {"origin_lat": 34.69365, "origin_lon": 135.51185},
        "sensors": [
            {"sensor_id": "S1", "x": 125, "y": 272,
             "location_name": "天神橋筋商店街 北入口付近", "start": "07:00",
             "method": "自転車カゴ・時間貸し駐輪場", "battery_mah": 2000},
            {"sensor_id": "S2", "x": 118, "y": 158,
             "location_name": "商店街中央 交差部(協力店舗)", "start": "07:05",
             "method": "協力店舗に温湿度計として設置", "battery_mah": 2000},
            {"sensor_id": "S3", "x": 125, "y": 25,
             "location_name": "天神橋北詰 南入口付近", "start": "07:10",
             "method": "サドルバッグ・時間貸し駐輪場", "battery_mah": 2000},
            {"sensor_id": "S4", "x": 205, "y": 150,
             "location_name": "東側路地 天満宮方面", "start": "07:15",
             "method": "自転車カゴ・時間貸し駐輪場", "battery_mah": 2000},
        ],
    },
}


def deep_merge(base: dict, override: dict) -> dict:
    """ネストした dict を再帰マージする(override が勝つ)。"""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load_settings(path: str | Path = "config/settings.yaml") -> dict:
    p = Path(path)
    data = yaml.safe_load(p.read_text(encoding="utf-8")) if p.exists() else None
    return deep_merge(DEFAULTS, data or {})


def parse_jst(value: str | datetime) -> datetime:
    """ISO8601 文字列を JST の tz-aware datetime にする。naive は JST とみなす。"""
    dt = datetime.fromisoformat(value) if isinstance(value, str) else value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    return dt.astimezone(JST)


class DeploymentsError(ValueError):
    pass


def load_deployments(path: str | Path) -> tuple[dict, list[dict]]:
    """deployments.yaml を読み、(メタ情報, 設置リスト) を返す。

    メタ情報: {"synthetic": bool} — ルートの generated_by が synth マーカーなら True。
    各設置は start_time を JST tz-aware datetime に変換して返す。
    """
    p = Path(path)
    if not p.exists():
        raise DeploymentsError(
            f"deployments ファイルがありません: {p}\n"
            "実データなら config/deployments.yaml を作成、"
            "合成データなら先に `bleflow synth` を実行してください。"
        )
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    meta = {"synthetic": str(raw.get("generated_by", "")).startswith(SYNTH_MARKER)}
    entries = raw.get("deployments")
    if not entries:
        raise DeploymentsError(f"{p}: `deployments:` が空です")

    deployments = []
    seen_ids: set[str] = set()
    for i, entry in enumerate(entries):
        for field in ("sensor_id", "file", "start_time"):
            if not entry.get(field):
                raise DeploymentsError(f"{p}: deployments[{i}] に {field} がありません")
        sensor_id = str(entry["sensor_id"])
        if sensor_id in seen_ids:
            raise DeploymentsError(f"{p}: sensor_id が重複しています: {sensor_id}")
        seen_ids.add(sensor_id)
        try:
            start = parse_jst(str(entry["start_time"]))
        except ValueError as exc:
            raise DeploymentsError(
                f"{p}: deployments[{i}].start_time を ISO8601 として解釈できません: {exc}"
            ) from exc
        deployments.append(
            {
                "sensor_id": sensor_id,
                "file": str(entry["file"]),
                "location_name": entry.get("location_name") or sensor_id,
                "lat": entry.get("lat"),
                "lon": entry.get("lon"),
                "start_time": start,
                "method": entry.get("method") or "",
                "battery_mah": entry.get("battery_mah"),
                "notes": entry.get("notes") or "",
            }
        )
    return meta, deployments


def load_or_create_salt(path: str | Path) -> str:
    """ソルトを読む。無ければ生成して保存する(gitignore 対象パス)。"""
    p = Path(path)
    if p.exists():
        salt = p.read_text(encoding="utf-8").strip()
        if not salt:
            raise ValueError(f"{p} が空です。削除して再実行すると自動生成されます。")
        return salt
    salt = secrets.token_hex(32)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(salt + "\n", encoding="utf-8")
    print(f"[bleflow] ソルトを新規生成しました: {p}(gitignore 対象。紛失すると別人扱いになるため保管してください)")
    return salt


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p
