"""合成データ生成器。

実データ到着前にパイプライン全体を検証するため、天神橋1丁目(約250m×300m)を
南西角原点のローカル座標系(m)でモデル化し、1日分の歩行者流動を生成する。

- 商店街の南北軸 x=125、東西の交差路 y=150 の2本の街路を歩行者が移動
- 朝(7-9時)・夕(17-19時)ピーク + 昼の小ピーク
- 通過者(数分)と滞留者(30分超)の混在
- MAC ランダム化(15〜20分ごと)と固定MAC端末の混在
- RSSI = 距離による伝搬損失 + ガウスノイズ、検出は確率的
- 4センサー分の CSV(実データと同一フォーマット)+ ground truth を出力

ground truth の定義:
- hourly: そのセンサーの稼働中に coverage_radius_m 以内へ入った実人数(時間帯別ユニーク)
- OD: 各人のセンサー訪問系列(連続重複を除去)の隣接遷移を数えた行列
"""

from __future__ import annotations

import math
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import polars as pl
import yaml

from .config import JST, SYNTH_MARKER, ensure_dir, parse_jst

# ── シナリオ定義(ローカル座標系, m)──────────────────────────
ENTRANCES: dict[str, tuple[float, float]] = {
    "N": (125.0, 300.0),  # 商店街 北端
    "S": (125.0, 0.0),    # 天神橋北詰(南端)
    "E": (250.0, 150.0),  # 東側路地
    "W": (0.0, 150.0),    # 西側路地
}
CROSS = (125.0, 150.0)  # 商店街と東西路の交差部

# 無向ODペアの重み(南北の商店街貫通が最多)
PAIR_WEIGHTS: dict[tuple[str, str], float] = {
    ("N", "S"): 0.42,
    ("N", "E"): 0.13,
    ("S", "E"): 0.13,
    ("N", "W"): 0.08,
    ("S", "W"): 0.08,
    ("E", "W"): 0.08,
}

# 滞留スポット: (座標, 街路上のアンカー, 重み)
DWELL_SPOTS: list[tuple[tuple[float, float], tuple[float, float], float]] = [
    ((132.0, 142.0), (125.0, 142.0), 0.40),  # 交差部近くのカフェ(S2近傍)
    ((137.0, 38.0), (125.0, 38.0), 0.35),    # 南入口近くの店先(S3近傍)
    ((215.0, 158.0), (215.0, 150.0), 0.25),  # 東側路地のベンチ(S4近傍)
]

TYPES = ["A", "G", "S", "O"]

METERS_PER_DEG_LAT = 111_320.0


def _gauss(x: np.ndarray, mu: float, sd: float) -> np.ndarray:
    return np.exp(-0.5 * ((x - mu) / sd) ** 2)


def arrival_weights(hours: np.ndarray) -> np.ndarray:
    """時刻(時, float)ごとの到着重み。朝夕ピーク + 昼の小ピーク。"""
    return (
        0.35
        + 1.05 * _gauss(hours, 8.0, 0.8)
        + 0.45 * _gauss(hours, 12.5, 1.5)
        + 1.15 * _gauss(hours, 18.0, 0.9)
    )


def rotation_index(t_abs: np.ndarray, arrival: float, phase: float, interval: float) -> np.ndarray:
    """各時刻の MAC 世代番号。arrival-phase を起点に interval 秒ごとに +1。"""
    return ((t_abs - arrival + phase) // interval).astype(np.int64)


def random_mac(rng: np.random.Generator, rotating: bool) -> str:
    """ランダムMACを1つ生成。rotating は BLE RPA 風(上位2bit=01)にする。"""
    b = rng.integers(0, 256, size=6, dtype=np.uint8)
    if rotating:
        b[0] = (b[0] & 0x3F) | 0x40
    else:
        b[0] = (b[0] | 0x02) & 0xFE  # locally administered / unicast
    return ":".join(f"{v:02X}" for v in b)


def _walk_positions(waypoints: np.ndarray, speed: float) -> np.ndarray:
    """折れ線 waypoints(n,2) を speed[m/s] で歩いたときの1秒ごとの位置(m,2)。"""
    seg = np.diff(waypoints, axis=0)
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    cum = np.concatenate([[0.0], np.cumsum(seglen)])
    total = float(cum[-1])
    dur = max(1, math.ceil(total / speed))
    s = np.minimum(np.arange(dur + 1, dtype=np.float64) * speed, total)
    x = np.interp(s, cum, waypoints[:, 0])
    y = np.interp(s, cum, waypoints[:, 1])
    return np.column_stack([x, y])


def _to_latlon(x: float, y: float, origin_lat: float, origin_lon: float) -> tuple[float, float]:
    lat = origin_lat + y / METERS_PER_DEG_LAT
    lon = origin_lon + x / (METERS_PER_DEG_LAT * math.cos(math.radians(origin_lat)))
    return round(lat, 6), round(lon, 6)


class SynthAbort(RuntimeError):
    pass


def _check_deployments_writable(path: Path, force: bool) -> None:
    if not path.exists() or force:
        return
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not str(raw.get("generated_by", "")).startswith(SYNTH_MARKER):
        raise SynthAbort(
            f"{path} は手書きの deployments とみなし上書きしません。"
            "実データ運用中なら synth は不要です。上書きするには --force を付けてください。"
        )


def run_synth(settings: dict, force: bool = False) -> dict:
    cfg = settings["synth"]
    paths = settings["paths"]
    rng = np.random.default_rng(cfg["seed"])

    date = str(cfg["date"])
    day0 = parse_jst(f"{date}T00:00:00+09:00")
    sim_start = parse_jst(f"{date}T{cfg['sim_start']}:00+09:00")
    sim_end = parse_jst(f"{date}T{cfg['sim_end']}:00+09:00")
    start_epoch = int(sim_start.timestamp())
    end_epoch = int(sim_end.timestamp())
    day0_epoch = int(day0.timestamp())

    deployments_path = Path(paths["deployments"])
    _check_deployments_writable(deployments_path, force)

    # ── センサー ─────────────────────────────────────────
    area = cfg["area"]
    sensors = []
    for s in cfg["sensors"]:
        start = parse_jst(f"{date}T{s['start']}:00+09:00")
        lat, lon = _to_latlon(float(s["x"]), float(s["y"]), area["origin_lat"], area["origin_lon"])
        sensors.append(
            {
                "sensor_id": s["sensor_id"],
                "x": float(s["x"]),
                "y": float(s["y"]),
                "start": start,
                "start_epoch": int(start.timestamp()),
                "lat": lat,
                "lon": lon,
                "location_name": s.get("location_name", s["sensor_id"]),
                "method": s.get("method", ""),
                "battery_mah": s.get("battery_mah", 2000),
            }
        )

    # ── 人物属性を一括サンプリング(順序固定で決定的)────────────
    n = int(cfg["n_persons"])
    minutes = np.arange(start_epoch, end_epoch, 60)
    w = arrival_weights((minutes - day0_epoch) / 3600.0)
    p_minutes = w / w.sum()
    arr_min = rng.choice(len(minutes), size=n, p=p_minutes)
    arr_sec = rng.integers(0, 60, size=n)
    arrivals = minutes[arr_min] + arr_sec  # epoch 秒

    type_probs = np.array([cfg["type_shares"][t] for t in TYPES], dtype=float)
    type_probs = type_probs / type_probs.sum()
    types = rng.choice(TYPES, size=n, p=type_probs)

    u_fixed = rng.random(n)
    fixed_prob = np.array([cfg["fixed_mac_prob"][t] for t in types], dtype=float)
    is_fixed = u_fixed < fixed_prob

    rot_lo, rot_hi = cfg["mac_rotation_min"]
    rot_iv = rng.uniform(rot_lo * 60.0, rot_hi * 60.0, size=n)
    rot_phase = rng.random(n) * rot_iv

    is_dwell = rng.random(n) < float(cfg["dwell_share"])

    pairs = list(PAIR_WEIGHTS)
    pw = np.array([PAIR_WEIGHTS[p_] for p_ in pairs], dtype=float)
    pw = pw / pw.sum()
    pair_idx = rng.choice(len(pairs), size=n, p=pw)
    u_dir = rng.random(n)

    sp_mean, sp_sd = cfg["speed_mps"]
    speeds = np.clip(rng.normal(sp_mean, sp_sd, size=n), 0.7, 2.0)

    spot_w = np.array([s[2] for s in DWELL_SPOTS], dtype=float)
    spot_idx = rng.choice(len(DWELL_SPOTS), size=n, p=spot_w / spot_w.sum())
    dw_lo, dw_hi = cfg["dwell_minutes"]
    dwell_dur = rng.uniform(dw_lo * 60.0, dw_hi * 60.0, size=n)

    ent_names = list(ENTRANCES)
    marginal = np.array(
        [sum(wt for pr, wt in PAIR_WEIGHTS.items() if e in pr) for e in ent_names], dtype=float
    )
    exit_idx = rng.choice(len(ent_names), size=n, p=marginal / marginal.sum())

    # ── シミュレーション ──────────────────────────────────
    rssi_cfg = cfg["rssi"]
    tx = float(rssi_cfg["tx_power_1m"])
    ple = float(rssi_cfg["path_loss_exp"])
    noise_sd = float(rssi_cfg["noise_sd"])
    thr = float(rssi_cfg["detect_threshold"])
    p_det = float(cfg["detect_prob_per_sec"])
    cov_r = float(cfg["coverage_radius_m"])

    det_rows: dict[str, dict[str, list]] = {
        s["sensor_id"]: {"t": [], "rssi": [], "pid": [], "mac_idx": []} for s in sensors
    }
    truth_hour: dict[tuple[str, int], set[int]] = {}
    od_counter: Counter[tuple[str, str]] = Counter()
    person_kind = np.where(is_dwell, "dwell", "transit")

    def _favored_dir(a: str, b: str, hour: float, u: float) -> tuple[str, str]:
        """時刻に応じた方向選択。朝は S/E 方面へ、夕方は N/W 方面へ偏らせる。"""
        if hour < 11:
            favored = {"S", "E"}
        elif hour >= 16:
            favored = {"N", "W"}
        else:
            favored = set()
        d1, d2 = (a, b), (b, a)
        if (d1[1] in favored) == (d2[1] in favored):
            return d1 if u < 0.5 else d2
        pick_d1 = d1[1] in favored
        return (d1 if pick_d1 else d2) if u < 0.62 else (d2 if pick_d1 else d1)

    for pid in range(n):
        prng = np.random.default_rng([int(cfg["seed"]), pid])
        arrival = int(arrivals[pid])
        hour_f = (arrival - day0_epoch) / 3600.0
        a, b = pairs[pair_idx[pid]]
        origin, dest = _favored_dir(a, b, hour_f, u_dir[pid])

        if is_dwell[pid]:
            spot, anchor, _ = DWELL_SPOTS[spot_idx[pid]]
            exit_ent = ent_names[exit_idx[pid]]
            wp_in = np.array([ENTRANCES[origin], CROSS, anchor, spot])
            wp_out = np.array([spot, anchor, CROSS, ENTRANCES[exit_ent]])
            wp_in = wp_in + prng.normal(0.0, 1.5, size=wp_in.shape)
            wp_out = wp_out + prng.normal(0.0, 1.5, size=wp_out.shape)
            pos_in = _walk_positions(wp_in, speeds[pid])
            n_dwell = int(dwell_dur[pid])
            pos_dw = np.asarray(wp_in[-1]) + prng.normal(0.0, 0.8, size=(n_dwell, 2))
            pos_out = _walk_positions(wp_out, speeds[pid])
            pos = np.concatenate([pos_in, pos_dw, pos_out])
        else:
            wp = np.array([ENTRANCES[origin], CROSS, ENTRANCES[dest]])
            wp = wp + prng.normal(0.0, 1.5, size=wp.shape)
            pos = _walk_positions(wp, speeds[pid])

        t_abs = arrival + np.arange(len(pos), dtype=np.int64)
        keep = t_abs <= end_epoch
        if not keep.all():
            pos, t_abs = pos[keep], t_abs[keep]
        if len(t_abs) == 0:
            continue

        visits: list[tuple[int, str]] = []
        for s in sensors:
            d = np.hypot(pos[:, 0] - s["x"], pos[:, 1] - s["y"])
            up = t_abs >= s["start_epoch"]

            cov = (d <= cov_r) & up
            if cov.any():
                # 時間帯別 ground truth(センサー稼働中の在圏でカウント)
                for h in np.unique((t_abs[cov] - day0_epoch) // 3600):
                    truth_hour.setdefault((s["sensor_id"], int(h)), set()).add(pid)
                # 在圏区間ごとに訪問イベント(OD ground truth 用、再訪も数える)
                idx = np.flatnonzero(cov)
                run_starts = idx[np.concatenate([[True], np.diff(idx) > 1])]
                visits.extend((int(t_abs[i]), s["sensor_id"]) for i in run_starts)

            rssi = tx - 10.0 * ple * np.log10(np.maximum(d, 1.0))
            rssi = rssi + prng.normal(0.0, noise_sd, size=len(d))
            det = (rssi >= thr) & (prng.random(len(d)) < p_det) & up
            if det.any():
                rows = det_rows[s["sensor_id"]]
                rows["t"].append(t_abs[det])
                rows["rssi"].append(np.rint(np.clip(rssi[det], -100, -30)).astype(np.int64))
                rows["pid"].append(np.full(int(det.sum()), pid, dtype=np.int64))
                if is_fixed[pid]:
                    rows["mac_idx"].append(np.zeros(int(det.sum()), dtype=np.int64))
                else:
                    rows["mac_idx"].append(
                        rotation_index(t_abs[det], arrival, rot_phase[pid], rot_iv[pid])
                    )

        visits.sort()
        seq = [v[1] for v in visits]
        for prev, nxt in zip(seq, seq[1:]):
            if prev != nxt:
                od_counter[(prev, nxt)] += 1

    # ── MAC 文字列の割り当て(人×世代ごとに決定的に生成)─────────
    mac_table: dict[tuple[int, int], str] = {}
    for s in sensors:
        rows = det_rows[s["sensor_id"]]
        if not rows["t"]:
            continue
        for pid_arr, idx_arr in zip(rows["pid"], rows["mac_idx"]):
            for pid, midx in zip(pid_arr.tolist(), idx_arr.tolist()):
                mac_table.setdefault((pid, midx), None)
    for pid, midx in sorted(mac_table):
        mrng = np.random.default_rng([int(cfg["seed"]), 7_777_777, pid, midx])
        mac_table[(pid, midx)] = random_mac(mrng, rotating=not is_fixed[pid])

    # ── センサーCSV 出力 ─────────────────────────────────
    raw_dir = ensure_dir(paths["raw_dir"])
    date_compact = date.replace("-", "")
    files: dict[str, str] = {}
    rows_per_sensor: dict[str, int] = {}
    for s in sensors:
        sid = s["sensor_id"]
        rows = det_rows[sid]
        if rows["t"]:
            t = np.concatenate(rows["t"])
            rssi = np.concatenate(rows["rssi"])
            pid_arr = np.concatenate(rows["pid"])
            midx = np.concatenate(rows["mac_idx"])
            macs = [mac_table[(p_, m_)] for p_, m_ in zip(pid_arr.tolist(), midx.tolist())]
            df = pl.DataFrame(
                {
                    "elapsed_sec": t - s["start_epoch"],
                    "mac": macs,
                    "rssi": rssi,
                    "type": [str(types[p_]) for p_ in pid_arr.tolist()],
                }
            ).sort(["elapsed_sec", "mac"])
        else:
            df = pl.DataFrame(
                schema={"elapsed_sec": pl.Int64, "mac": pl.String, "rssi": pl.Int64, "type": pl.String}
            )
        out = raw_dir / f"{sid}_synth_{date_compact}.csv"
        df.write_csv(out)
        files[sid] = str(out)
        rows_per_sensor[sid] = len(df)

    # ── ground truth 出力 ────────────────────────────────
    synth_dir = ensure_dir(paths["synth_dir"])
    h_lo = (start_epoch - day0_epoch) // 3600
    h_hi = math.ceil((end_epoch - day0_epoch) / 3600)
    gt_rows = []
    for s in sensors:
        for h in range(h_lo, h_hi):
            pids = truth_hour.get((s["sensor_id"], h), set())
            hour_start = day0 + timedelta(hours=int(h))
            gt_rows.append(
                {
                    "hour_start": hour_start.isoformat(),
                    "sensor_id": s["sensor_id"],
                    "true_unique_persons": len(pids),
                    "true_transit": sum(1 for p_ in pids if person_kind[p_] == "transit"),
                    "true_dwell": sum(1 for p_ in pids if person_kind[p_] == "dwell"),
                }
            )
    gt_hourly = pl.DataFrame(gt_rows)
    gt_hourly_path = synth_dir / "ground_truth.csv"
    gt_hourly.write_csv(gt_hourly_path)

    od_rows = [
        {"from_sensor": a_, "to_sensor": b_, "true_count": c_}
        for (a_, b_), c_ in sorted(od_counter.items())
    ]
    gt_od = pl.DataFrame(
        od_rows,
        schema={"from_sensor": pl.String, "to_sensor": pl.String, "true_count": pl.Int64},
    )
    gt_od_path = synth_dir / "ground_truth_od.csv"
    gt_od.write_csv(gt_od_path)

    # ── deployments.yaml 出力 ────────────────────────────
    dep = {
        "generated_by": f"{SYNTH_MARKER} v0.1",
        "synthetic": True,
        "deployments": [
            {
                "sensor_id": s["sensor_id"],
                "file": files[s["sensor_id"]],
                "location_name": s["location_name"],
                "lat": s["lat"],
                "lon": s["lon"],
                "start_time": s["start"].isoformat(),
                "method": s["method"],
                "battery_mah": s["battery_mah"],
                "notes": f"synth 生成(ローカル座標 x={s['x']:.0f}m, y={s['y']:.0f}m)",
            }
            for s in sensors
        ],
    }
    deployments_path.parent.mkdir(parents=True, exist_ok=True)
    deployments_path.write_text(
        "# bleflow synth が生成した設置メタデータ(合成データ用)。\n"
        "# 実データ運用時はこのファイルを手書きで置き換え、generated_by 行を削除すること。\n"
        + yaml.safe_dump(dep, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    summary = {
        "n_persons": n,
        "n_transit": int((~is_dwell).sum()),
        "n_dwell": int(is_dwell.sum()),
        "rows_per_sensor": rows_per_sensor,
        "files": files,
        "ground_truth": str(gt_hourly_path),
        "ground_truth_od": str(gt_od_path),
        "deployments": str(deployments_path),
        "truth_total_od": int(sum(od_counter.values())),
    }
    print(f"[synth] 仮想歩行者 {n} 人(通過 {summary['n_transit']} / 滞留 {summary['n_dwell']})を生成")
    for sid, cnt in rows_per_sensor.items():
        print(f"[synth]   {sid}: {cnt:>7,} 検出 → {files[sid]}")
    print(f"[synth] ground truth: {gt_hourly_path} / {gt_od_path}")
    print(f"[synth] deployments : {deployments_path}")
    return summary
