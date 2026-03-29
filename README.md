# InfoRadar - ANA SFC お得レート自動検索

ANA（全日空）の特典航空券のマイル単価を計算し、お得な路線・日程を自動検索するCLIツールです。

## セットアップ

```bash
pip install -r requirements.txt
```

## 使い方

```bash
# 設定ファイルで検索
python -m inforadar

# お得なレートのみ表示
python -m inforadar --deals-only

# 閾値を変更（デフォルト: 2.0円/マイル）
python -m inforadar --threshold 3.0

# カスタム設定ファイル
python -m inforadar -c my_config.yaml

# 詳細表示
python -m inforadar -v
```

## 設定（config.yaml）

`config.yaml` で検索路線・期間・クラス等を設定できます。

## マイル単価とは

**マイル単価** = 有償航空券の価格 ÷ 必要マイル数

一般的な目安:
- **1円/マイル以下**: 損
- **1〜2円/マイル**: 普通
- **2〜3円/マイル**: お得 ★
- **3円/マイル以上**: かなりお得 ★★〜★★★
