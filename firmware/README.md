# firmware/ — 参照用ファームウェア置き場

ESP32-C3 SuperMini 用ファームウェア `one_day_test.ino`(BLE パッシブスキャン、SPIFFS 保存)を
後日ここに置く。**参照専用**であり、本リポジトリのアプリケーションはこのディレクトリの
存在に一切依存しない。

- 出力フォーマット: `elapsed_sec,mac,rssi,type`(ヘッダ付き CSV)
- RTC なし。`elapsed_sec` は起動からの経過秒
- データ回収は USB シリアル経由の手動取り出し → `data/raw/` に配置
