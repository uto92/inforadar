"""E2E: bleflow demo を小規模合成データで一気通貫実行し、成果物と精度を検証する。"""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from click.testing import CliRunner

from bleflow.cli import main


def test_demo_end_to_end(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config").mkdir()
    settings = {
        "synth": {"n_persons": 500, "seed": 7},
    }
    (tmp_path / "config" / "settings.yaml").write_text(
        yaml.safe_dump(settings), encoding="utf-8"
    )

    runner = CliRunner()
    result = runner.invoke(main, ["demo"], catch_exceptions=False)
    assert result.exit_code == 0, result.output

    # 成果物一式
    assert Path("data/bleflow.duckdb").exists()
    assert Path("data/synth/ground_truth.csv").exists()
    assert Path("data/synth/ground_truth_od.csv").exists()
    assert Path("config/salt.txt").exists()
    report = Path("output/report.html")
    assert report.exists()

    # 精度: Phase 1 完了条件(±15%)を満たす
    data = json.loads(Path("output/analysis/report_data.json").read_text(encoding="utf-8"))
    acc = data["accuracy"]
    assert acc is not None
    assert acc["pass_15"] is True, f"WAPE={acc['weighted_mape_pct']}"
    assert acc["weighted_mape_pct"] <= 15.0

    # レポートに主要セクションが含まれる
    html = report.read_text(encoding="utf-8")
    for needle in ("精度検証", "ヒートマップ", "OD フロー", "センサーサマリー", "合成データ"):
        assert needle in html

    # プライバシー: 生MAC(コロン区切りMAC形式)が処理後成果物に残っていない
    raw_macs = set()
    for csv in Path("data/raw").glob("*.csv"):
        for line in csv.read_text().splitlines()[1:50]:
            raw_macs.add(line.split(",")[1])
    assert raw_macs
    for artifact in [html, Path("output/analysis/report_data.json").read_text(encoding="utf-8")]:
        assert not any(m in artifact for m in raw_macs)


def test_ingest_fails_gracefully_without_deployments(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(main, ["ingest"])
    assert result.exit_code != 0
    assert "deployments" in result.output
