"""report のテスト: 実データモード(accuracy/map/truth なし)でも壊れないこと。"""

from __future__ import annotations

from bleflow.report import render_report

SENSORS = ["S1", "S2"]


def minimal_data(with_optional: bool = False) -> dict:
    hours = ["2026-08-01T07:00:00+09:00", "2026-08-01T08:00:00+09:00"]
    data = {
        "generated_at": "2026-08-02T10:00:00+09:00",
        "title": "テストレポート",
        "mode": "real",
        "period": {"start": "2026-08-01T07:00:00+09:00", "end": "2026-08-01T09:00:00+09:00"},
        "totals": {"detections": 100, "sessions": 10, "unique_devices": 8, "unique_corrected": 7.2},
        "sensors": [
            {
                "sensor_id": sid,
                "location_name": f"場所{sid}",
                "lat": None,
                "lon": None,
                "start_time": "2026-08-01T07:00:00+09:00",
                "method": "テスト設置",
                "n_detections": 50,
                "n_sessions": 5,
                "unique_devices": 4,
                "unique_corrected": 3.6,
            }
            for sid in SENSORS
        ],
        "bins": {
            m: {
                "labels": hours,
                "unique": {sid: [1, 2] for sid in SENSORS},
                "detections": {sid: [3, 4] for sid in SENSORS},
            }
            for m in ("5", "15")
        },
        "hourly": {
            "hours": hours,
            "raw": {sid: [1, 2] for sid in SENSORS},
            "corrected": {sid: [0.9, 1.8] for sid in SENSORS},
        },
        "classes": {"sensors": SENSORS, "transit": [3, 2], "uncertain": [1, 0], "dwell": [1, 1]},
        "device_types": {
            "overall": {"A": 5, "G": 2, "S": 1, "O": 0},
            "per_sensor": {sid: {"A": 3, "G": 1, "S": 0, "O": 0} for sid in SENSORS},
        },
        "rssi_hist": {"edges": [-100, -95, -90], "per_sensor": {sid: [1, 2] for sid in SENSORS}},
        "duration_hist": {"labels": ["0–10秒", "10–30秒"], "per_sensor": {sid: [1, 2] for sid in SENSORS}},
        "od": {"sensors": SENSORS, "matrix": [[0, 1], [2, 0]], "total": 3, "truth": None, "truth_total": None},
        "map": None,
        "accuracy": None,
        "population": {
            "unique_devices_all": 8,
            "corrected_devices_all": 7.2,
            "observed_ios_share": 0.62,
            "expected_ios_share": 0.62,
            "detectable_rate": 0.35,
            "est_total_pedestrians": 21,
        },
        "params": {
            "session_gap_sec": 30,
            "transit_max_sec": 60,
            "dwell_min_sec": 120,
            "randomization_correction": 0.9,
            "od_max_gap_min": 15,
        },
    }
    if with_optional:
        data["mode"] = "synthetic"
        data["map"] = {
            "sensors": [
                {"sensor_id": sid, "lat": 34.69, "lon": 135.51, "location_name": f"場所{sid}"}
                for sid in SENSORS
            ]
        }
        data["od"]["truth"] = [[0, 2], [2, 0]]
        data["od"]["truth_total"] = 4
        data["accuracy"] = {
            "weighted_mape_pct": 9.9,
            "total_true": 100,
            "total_raw": 110,
            "total_corrected": 99.0,
            "total_err_pct": -1.0,
            "pass_15": True,
            "hourly": [
                {
                    "hour_start": hours[0],
                    "sensor_id": "S1",
                    "true": 10,
                    "raw": 11,
                    "corrected": 9.9,
                    "err_pct": -1.0,
                }
            ],
        }
    return data


def test_render_real_mode_omits_optional_sections():
    html = render_report(minimal_data(with_optional=False))
    assert "テストレポート" in html
    assert "実データ" in html
    assert "精度検証" not in html          # accuracy なし → セクション省略
    assert 'id="map"' not in html          # lat/lon なし → マップ省略
    assert "cdn.jsdelivr.net/npm/leaflet" not in html  # Leaflet の読み込み自体を省く
    assert "ground truth)" not in html     # 真値OD行列なし
    assert "プライバシー" in html


def test_render_synthetic_mode_includes_optional_sections():
    html = render_report(minimal_data(with_optional=True))
    assert "精度検証" in html and "PASS" in html
    assert 'id="map"' in html and "cdn.jsdelivr.net/npm/leaflet" in html
    assert "合成データ" in html


def test_render_escapes_script_close_in_json():
    data = minimal_data()
    data["sensors"][0]["location_name"] = "悪意</script><script>alert(1)"
    html = render_report(data)
    assert "</script><script>alert(1)" not in html
