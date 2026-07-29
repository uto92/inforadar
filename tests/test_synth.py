"""synth のテスト: 出力フォーマット・決定性・ローテーションの基本性質。"""

from __future__ import annotations

import copy

import numpy as np
import polars as pl
import pytest

from bleflow.config import DEFAULTS, load_deployments
from bleflow.synth import arrival_weights, random_mac, rotation_index, run_synth


def small_settings() -> dict:
    settings = copy.deepcopy(DEFAULTS)
    settings["synth"]["n_persons"] = 150
    settings["synth"]["sim_start"] = "07:00"
    settings["synth"]["sim_end"] = "11:00"
    return settings


@pytest.fixture()
def tmp_repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_synth_outputs_and_format(tmp_repo):
    settings = small_settings()
    summary = run_synth(settings)

    assert summary["n_persons"] == 150
    assert set(summary["files"]) == {"S1", "S2", "S3", "S4"}

    df = pl.read_csv(summary["files"]["S2"])
    assert df.columns == ["elapsed_sec", "mac", "rssi", "type"]
    assert df["elapsed_sec"].min() >= 0
    assert df["elapsed_sec"].is_sorted()
    assert df["rssi"].max() <= -30 and df["rssi"].min() >= -100
    assert set(df["type"].unique().to_list()) <= {"A", "G", "S", "O"}
    # MAC は AA:BB:CC:DD:EE:FF 形式
    assert df["mac"].str.contains(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$").all()

    # ground truth: 稼働時間帯ぶんの行があり、合計人数は総人数を超えない(1人が複数時間帯に跨がる場合はある)
    gt = pl.read_csv(summary["ground_truth"])
    assert gt.columns == ["hour_start", "sensor_id", "true_unique_persons", "true_transit", "true_dwell"]
    assert (
        gt["true_unique_persons"] == gt["true_transit"] + gt["true_dwell"]
    ).all()

    # deployments.yaml が synth マーカー付きで生成され、読み込みできる
    meta, deps = load_deployments(summary["deployments"])
    assert meta["synthetic"] is True
    assert [d["sensor_id"] for d in deps] == ["S1", "S2", "S3", "S4"]
    assert all(d["start_time"].tzinfo is not None for d in deps)


def test_synth_deterministic(tmp_repo):
    settings = small_settings()
    run_synth(settings)
    first = {sid: open(f, "rb").read() for sid, f in run_synth(settings)["files"].items()}
    second = {sid: open(f, "rb").read() for sid, f in run_synth(settings)["files"].items()}
    assert first == second


def test_synth_refuses_handwritten_deployments(tmp_repo):
    from bleflow.synth import SynthAbort

    settings = small_settings()
    dep = tmp_repo / "config" / "deployments.yaml"
    dep.parent.mkdir(parents=True)
    dep.write_text("deployments:\n  - sensor_id: S1\n", encoding="utf-8")
    with pytest.raises(SynthAbort):
        run_synth(settings)
    # --force なら上書きできる
    run_synth(settings, force=True)
    meta, _ = load_deployments(dep)
    assert meta["synthetic"] is True


def test_rotation_index_interval():
    interval, phase = 1000.0, 300.0
    arrival = 10_000
    t = np.arange(arrival, arrival + 5000)
    idx = rotation_index(t, arrival, phase, interval)
    changes = t[1:][np.diff(idx) > 0] - arrival
    # 切替は interval 間隔、初回は interval - phase 秒後
    assert changes[0] == interval - phase
    assert np.all(np.diff(changes) == interval)


def test_random_mac_format():
    rng = np.random.default_rng(1)
    rot = random_mac(rng, rotating=True)
    fixed = random_mac(rng, rotating=False)
    assert len(rot) == 17 and len(fixed) == 17
    # ローテーションMACは BLE RPA 風(上位2bit = 01)
    assert (int(rot.split(":")[0], 16) & 0xC0) == 0x40


def test_arrival_weights_peaks():
    h = np.array([8.0, 11.0, 15.0, 18.0])
    w = arrival_weights(h)
    assert w[0] > w[1]  # 朝ピーク > 昼前
    assert w[3] > w[2]  # 夕ピーク > 午後
