# InfoRadar

公開情報モニタリング。RSS/Atom フィードを定期巡回して差分（新着）を検知し、Markdown レポートを生成、Gmail で通知します。

「探しに行く」のではなく「向こうから届く」状態を作るためのレーダーです。

## 仕組み

```
feeds.yaml（監視ソース定義: RSS / HTML）
    │
    ▼
inforadar.py ── 取得 → state.json と突合 → 新着抽出・キーワード判定
    │
    ├─ reports/YYYY-MM-DD.md（レポート）
    └─ Gmail 通知（--notify・新着ありのときのみ）
```

- **実行基盤**: GitHub Actions（毎朝 07:30 JST）。`state.json` と `reports/` はワークフローがコミットして永続化。
- **差分検知**: エントリID（id → link フォールバック）のハッシュを既読管理。フィードごと上限500件。
- **初回取得**: 全件をベースライン登録し、直近5件のみレポート表示（初回の洪水を防ぐ）。
- **キーワード**: `feeds.yaml` の `global_keywords`／フィード別 `keywords` にマッチした記事は ★ 付きで上位表示。
- **HTML監視**: RSS 非提供サイトは `type: html` で監視。ページ内リンクを `link_pattern`（正規表現・絶対URLに適用）で絞り込み、新しいリンクURLの出現＝新着とみなす。パターンに1件も合致しない場合は取得失敗として警告（ページ構造の変化を検知）。
- **障害耐性**: 個別フィードの取得失敗は握りつぶさず「⚠️ 取得失敗」セクションに記載し、他のフィードは続行。

## 使い方

```bash
pip install -r requirements.txt
python inforadar.py            # ドライラン（レポート生成のみ）
python inforadar.py --notify   # Gmail 通知あり
```

## Gmail 通知の設定

Google アカウントで[アプリパスワード](https://myaccount.google.com/apppasswords)を発行し、リポジトリの Actions Secrets に登録します。

| Secret | 内容 |
|---|---|
| `GMAIL_ADDRESS` | 送信元 Gmail アドレス |
| `GMAIL_APP_PASSWORD` | アプリパスワード（16桁） |
| `MAIL_TO` | 宛先（省略時は `GMAIL_ADDRESS` と同じ） |

Secrets 未設定の場合、通知はスキップされレポート生成のみ行われます（ドライラン相当）。

## 監視ソースの追加

`feeds.yaml` にエントリを追加します。

```yaml
# RSS/Atom フィード
- name: 表示名
  url: https://example.com/feed
  keywords: [任意のハイライト語]
  enabled: true   # 省略可

# RSS 非提供サイト（HTML監視）
- name: 表示名
  type: html
  url: https://example.com/press/
  link_pattern: "/press/article/"   # 記事リンクを絞る正規表現
```

> **注意**: 初期の URL 群と link_pattern は開発環境から疎通未確認です。初回の Actions 実行レポートの「⚠️ 取得失敗」を見て、動かないソースを修正してください。

## 今後の拡張候補

- グッドデザイン賞・JR九州・Helpfeel の link_pattern 確定（feeds.yaml のコメント参照）
- PR TIMES 企業別 RSS の組み込み
- 週次サマリー（LLM 要約）
