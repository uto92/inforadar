# ble-flow — BLE 人流センサー分析基盤

ESP32-C3 SuperMini の BLE パッシブスキャンで大阪市北区・天神橋1丁目(約250m×300m)の
歩行者流動を計測する個人研究プロジェクトの**ソフトウェア側**リポジトリ。
グラフ理論による配置最適化で **4センサーが全ODペア最短経路を100%カバー**(2台で84.4%)。
設置は私物ベース(駐輪場の自転車カゴ、協力店舗など)で公共物への設置許可を要しない手法。

ファームウェア(`one_day_test.ino`)は完成済み・スコープ外。`firmware/` は参照用置き場で、
**アプリはその存在に依存しない**。

## パイプライン

```
synth(合成データ) ─┐
                    ├→ data/raw/*.csv → ingest → data/bleflow.duckdb → analyze → output/analysis/* → report → output/report.html
実センサーCSV ──────┘                                (detections/sessions)         (集計CSV+report_data.json)
```

CLI(uv 管理、`[project.scripts]` で登録):

```bash
uv run bleflow synth     # 合成データ生成(+ config/deployments.yaml を synth 用に生成)
uv run bleflow ingest    # deployments.yaml に従い DuckDB へ取り込み
uv run bleflow analyze   # 分析(集計CSV + output/analysis/report_data.json)
uv run bleflow report    # output/report.html 生成(自己完結・単一HTML)
uv run bleflow demo      # 上記4つを一気通貫実行
uv run pytest            # テスト
```

## データ仕様(要点)

### センサー生ログ(1センサー・1セッション = 1 CSV)

```csv
elapsed_sec,mac,rssi,type
12,4A:BB:CC:DD:EE:01,-67,A
```

- `elapsed_sec`: **起動からの経過秒**(整数)。センサーに RTC が無いため、
  実時刻 = `deployments.yaml` の `start_time` + `elapsed_sec` としてソフト側で変換する
- `mac`: BLE MAC。iOS 14+ / Android 10+ は**約15〜20分ごとにランダム化**される
- `rssi`: dBm(おおむね -30〜-100。-45=近い、-80=遠い)
- `type`: Manufacturer ID による推定。`A`=Apple / `G`=Google / `S`=Samsung / `O`=その他
- 1行 = 1検出イベント。同一 MAC が数秒間隔で繰り返し出現する

### 設置メタデータ `config/deployments.yaml`

sensor_id / file / location_name / lat / lon(未設置時は null)/ start_time(ISO8601 +09:00)/
method / battery_mah / notes。ルートに `generated_by: bleflow-synth` があるものは synth の
生成物(実データ運用時は手書きに置き換える。synth はマーカーの無いファイルを上書きしない)。

## プライバシー原則(必須・変更禁止)

1. **取り込み時に MAC をソルト付き SHA-256 でハッシュ化**。processed 以降のデータ・DB・
   レポート・ログ出力に生 MAC を一切残さない
2. ソルトは `config/salt.txt`(gitignore 対象)。無ければ ingest が自動生成する
3. 出力は集計統計のみ。**個人の特定・追跡を目的とする機能は実装しない**
4. `data/raw/`・`config/salt.txt` は gitignore 済み。解除しない

## 主要ロジックの定義

- **セッション化**: 同一 (sensor_id, mac_hash) の連続検出を、検出間ギャップ **> 30秒**
  (`ingest.session_gap_sec`)で分割。ちょうど30秒は同一セッション。
  1セッション = first_seen / last_seen / duration_sec / avg_rssi / max_rssi / n_detections / type / sensor_id
- **通過/滞留**: duration < 60s = 通過(transit)、≥ 120s = 滞留(dwell)、中間 = 不定(uncertain)。
  閾値は `analyze.transit_max_sec` / `analyze.dwell_min_sec`
- **ランダム化補正**: 長時間滞留者は MAC 切替で 5〜15% 多めに数えられるため、
  ユニーク数 × `analyze.randomization_correction`(デフォルト 0.9)を補正値とする
- **OD 突合(Phase 2)**: 同一 mac_hash のセッションを first_seen 順に並べ、隣接ペアが
  異なるセンサーかつギャップ(前の last_seen → 次の first_seen)≤ 15分ならODペアとして加算
- **精度検証**: synth 実行時は `data/synth/ground_truth.csv`(センサー×時間帯の真値)と比較し、
  真値加重 MAPE を算出。Phase 1 完了条件 = **誤差 ±15% 以内**

## 時刻の扱い

- すべて JST(`Asia/Tokyo`)、**tz-aware** で統一。naive な datetime を作らない
- DuckDB は TIMESTAMPTZ、polars は `Datetime(time_unit="us", time_zone="Asia/Tokyo")`
- 変換の一次情報は `start_time + elapsed_sec` のみ(センサー時計は信用しない)

## コーディング規約

- Python 3.11+、パッケージ管理は **uv**(依存追加は `uv add`、実行は `uv run`)
- データ処理は **polars**(pandas は使わない)、保存は DuckDB、テンプレートは Jinja2、CLI は click
- モジュール構成は `src/bleflow/{cli,synth,ingest,analyze,report,config}.py` を維持。
  cli.py はコマンド内で遅延 import(起動高速化と部分的な動作のため)
- 乱数は必ずシード指定(`synth.seed`)。synth は同一設定で決定的に同一出力を出すこと
- セッション化・実時刻変換・分類閾値のロジック変更時は必ず pytest を更新して通すこと
- レポートは**自己完結の単一 HTML**(データは JSON 埋め込み、Chart.js / Leaflet は CDN 可)
- コミットはコンポーネント単位で小さく。件名は日本語で `feat(scope): 説明` 形式

## フェーズ

- **Phase 1(実装済み)**: synth → ingest → analyze(単一センサー分析)→ report、demo 一括実行
- **Phase 2(一部先行実装)**: 4センサー OD 突合・マップ/フロー可視化(analyze/report に組込済み、精度改善は今後)
- **Phase 3(未着手)**: WiFi プローブ併用データ形式、Cloudflare Workers + D1 / Supabase 取り込み自動化
