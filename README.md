# ble-flow — BLE パッシブスキャン人流分析基盤

ESP32-C3 SuperMini を使った BLE パッシブスキャンセンサーで、大阪市北区・**天神橋1丁目**
(約250m×300m)の歩行者流動を計測する個人研究プロジェクトのソフトウェア側です。
グラフ理論による配置最適化の結果、**4センサーで全ODペアの最短経路を100%カバー**
(2台で84.4%)できることが判明しており、本リポジトリはそのデータ処理・分析・可視化を担います。

- センサー設置は私物ベース(時間貸し駐輪場の自転車カゴ、協力店舗の「温湿度計」など)
- センサーに RTC なし → ログは起動からの経過秒。実時刻変換はソフト側で実施
- データ回収は USB シリアル経由の手動 CSV 取り出し(クラウド送信は Phase 3)
- ファームウェアは完成済みで本リポジトリのスコープ外(`firmware/` は参照用)

## プライバシー

- 取り込み時に MAC を**ソルト付き SHA-256 でハッシュ化**。DB・集計・レポートに生 MAC は一切残りません
- ソルト(`config/salt.txt`)と生ログ(`data/raw/`)は gitignore 済み
- 出力は集計統計のみで、個人の特定・追跡を目的とする機能はありません

## セットアップ

[uv](https://docs.astral.sh/uv/) と Python 3.11+ が必要です。

```bash
uv sync
```

## クイックスタート(合成データで一気通貫)

```bash
uv run bleflow demo
```

実データ到着前にパイプライン全体を検証するため、天神橋1丁目を想定した合成データ
(朝夕ピーク・通過/滞留混在・MACランダム化再現・4センサー)を生成し、
取り込み → 分析 → レポート生成まで実行します。最後に ground truth との誤差
(真値加重 MAPE、Phase 1 目標 ±15% 以内)を表示します。

生成物:

| パス | 内容 |
|---|---|
| `data/raw/S*_synth_*.csv` | 合成センサーログ(実データと同一フォーマット) |
| `data/synth/ground_truth.csv` | 真のセンサー×時間帯別ユニーク人数(検証用) |
| `data/synth/ground_truth_od.csv` | 真の OD 行列(検証用) |
| `data/bleflow.duckdb` | detections / sessions / deployments テーブル |
| `output/analysis/*.csv` | ビン集計・通過/滞留・OD 行列・精度検証など |
| `output/report.html` | **自己完結の単一 HTML ダッシュボード**(ブラウザで開くだけ) |

個別実行:

```bash
uv run bleflow synth      # 合成データ生成
uv run bleflow ingest     # deployments.yaml に従い取り込み
uv run bleflow analyze    # 分析実行
uv run bleflow report     # report.html 生成
```

## 実データでの運用手順

1. センサー設置時に `config/deployments.yaml` を手書きで作成(synth 生成版を置き換え):

   ```yaml
   deployments:
     - sensor_id: S1
       file: data/raw/S1_20260801.csv
       location_name: "天神橋筋商店街 北入口付近"
       lat: null        # 設置時に記入(nullならマップ省略)
       lon: null
       start_time: "2026-08-01T07:30:00+09:00"   # 設置(起動)時刻 JST
       method: "自転車カゴ・時間貸し駐輪場"
       battery_mah: 2000
       notes: ""
   ```

   ルートに `generated_by: bleflow-synth` の無いファイルは synth が上書きしません。

2. 回収した CSV(`elapsed_sec,mac,rssi,type`)を `data/raw/` に置く
3. `uv run bleflow ingest && uv run bleflow analyze && uv run bleflow report`
4. `output/report.html` をブラウザで開く(Chart.js / Leaflet は CDN 読込のためオンライン推奨。
   オフライン時はチャートが出ない旨のバナーを表示します)

## レポートの内容

- ユニークデバイス数の時系列(5分ビン・センサー別)/ 時間帯×センサーのヒートマップ
- 通過(<60s)/ 不定 / 滞留(≥120s)の構成、デバイス種別内訳(Apple/Google/Samsung/Other)
- RSSI 分布、セッション長分布
- lat/lon 入力済みならセンサー位置マップ(Leaflet)+ OD フロー(Phase 2 先行実装)
- 合成データ実行時は冒頭に ground truth との誤差サマリー

## 設定

`config/settings.yaml` で閾値・補正係数を変更できます(セッション分割ギャップ、
通過/滞留閾値、ランダム化補正係数 0.9、OD 突合ギャップ 15分、synth のシナリオなど)。
各項目の意味はファイル内コメントと `CLAUDE.md` を参照してください。

## 開発

```bash
uv run pytest           # セッション化・実時刻変換ほかのテスト
```

## ロードマップ

- **Phase 1(済)**: synth → ingest → analyze → report、`demo` 一括実行(誤差 ±15% 以内)
- **Phase 2(一部先行実装)**: 4センサー OD 突合、マップ・フロー可視化
- **Phase 3**: WiFi プローブ併用、Cloudflare Workers + D1 / Supabase への取り込み自動化
