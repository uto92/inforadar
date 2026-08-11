# WESTER来訪スキャナ（仮）

JR西日本の社員が、イベント会場や駅で来場者の WESTER 会員バーコードを iPhone で連続スキャンし、
「WESTER会員の来訪」を記録・集約するためのツールです。

- **オフラインファースト**: 圏外でも読取・蓄積・CSV書き出しが完結
- **自動同期**: 回線があれば未送信分をサーバ（Cloudflare Workers + D1）へ自動送信。uuid 冪等で再送しても重複しない
- **プライバシー切替点**: 検証段階は会員IDを生のまま HTTPS 送信。将来のハッシュ化は `transformID` 1箇所の差し替えで対応
- 配布は TestFlight（内部テスト）想定

## リポジトリ構成

```
├── ios/        # Xcodeプロジェクト（SwiftUI, iOS 17+, SwiftData, 外部SDKなし）
│   ├── WesterVisitScan.xcodeproj
│   ├── WesterVisitScan/          # アプリ本体
│   └── WesterVisitScanTests/     # classifyBarcode / transformID の単体テスト
├── server/     # Cloudflare Workers + D1（TypeScript, wrangler）
│                 # NFCプローブの接続仕様は server/NFC_PROBE.md
├── webapp/     # Web版チェックインツール（Vite + React, IndexedDB + Worker同期）
│               # → 詳細は webapp/README.md
└── README.md
```

## バーコード仕様（実測に基づく）

- 規格: **Codabar (NW-7)**（iOS標準の `AVCaptureMetadataOutput` で読取。`.codabar` は iOS 15.4+）
- 生読取値の例: `A328913579881A`
- 前後の `A` は Codabar のスタート/ストップ記号（`A`〜`D`・小文字も可）
- ガード除去後のコアが **数字ちょうど12桁** = WESTER会員ID
- QR / Code128 / EAN 等も検出はするが「WESTER会員証ではありません」として**保存しない**
- 桁数以外の厳密化（prefix・チェックディジット）は `ios/WesterVisitScan/Core/BarcodeClassifier.swift` の `IDRules` に将来設定

---

## 1. サーバのセットアップ（server/）

前提: Node.js 18+、Cloudflare アカウント

```bash
cd server
npm install

# 1) Cloudflare にログイン
npx wrangler login

# 2) D1 データベース作成 → 出力された database_id を wrangler.toml の
#    REPLACE_WITH_D1_DATABASE_ID に貼り付ける
npx wrangler d1 create wester-visit-scanner

# 3) マイグレーション適用（本番）
npm run migrate:remote

# 4) APIキーを Workers Secret に設定（例: openssl rand -hex 32 で生成した値を入力）
npx wrangler secret put API_KEY

# 5) デプロイ → 表示された https://wester-visit-scanner.xxx.workers.dev を控える
npm run deploy
```

### 疎通確認

```bash
BASE=https://wester-visit-scanner.xxx.workers.dev
KEY=（設定したAPIキー）

curl $BASE/v1/health
# → {"ok":true}

curl -X POST $BASE/v1/scans \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"records":[{"uuid":"11111111-1111-4111-8111-111111111111","wester_id":"328913579881","scanned_at":"2026-07-29T14:00:01+09:00","event":"テスト","location":"テスト","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","device_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]}'
# → {"accepted":1,"rejected":0}（同じものを再送しても重複しない）

curl -o scans.csv "$BASE/v1/export.csv?from=2026-07-01&to=2026-07-31&event=テスト" \
  -H "Authorization: Bearer $KEY"
```

### API仕様

| エンドポイント | 認証 | 説明 |
|---|---|---|
| `POST /v1/scans` | Bearer | `{ "records": [...] }` を受信。wester_id はサーバ側でも数字12桁を再検証し、違反レコードは破棄。uuid 主キーに INSERT OR IGNORE（冪等）。`{ accepted, rejected }` を返す |
| `GET /v1/export.csv?from=&to=&event=` | Bearer | フィルタ付きCSV（BOM付きUTF-8）。`from`/`to` は `YYYY-MM-DD` または ISO8601。日付のみの `to` はその日を含む |
| `GET /v1/health` | 不要 | 疎通確認 |

### ローカル開発

```bash
cd server
echo 'API_KEY=devtestkey123' > .dev.vars   # ローカル専用（gitignore済み）
npm run migrate:local
npm run dev                                 # http://localhost:8787
```

---

## 2. iOSアプリのセットアップ（ios/）

前提: Xcode 16+、Apple Developer Program のチーム、iOS 17+ の実機（カメラ必須）

1. `ios/WesterVisitScan.xcodeproj` を Xcode で開く
2. **Bundle ID の変更**（現状はプレースホルダ `jp.example.westervisitscan`）
   - TARGETS → WesterVisitScan → Signing & Capabilities で **Team** を選択
   - 同画面の **Bundle Identifier** を自社のID（例: `jp.co.example.westervisitscan`）へ変更
   - テストターゲット WesterVisitScanTests の Bundle Identifier も同様に変更
3. 実機を選んで Run（初回起動時にカメラ利用許可のダイアログが出ます）
4. 単体テスト: `Cmd+U`（または `xcodebuild test -project ios/WesterVisitScan.xcodeproj -scheme WesterVisitScan -destination 'platform=iOS Simulator,name=iPhone 16'`）

### TestFlight 配布

1. Product → **Archive**（スキームは WesterVisitScan / Any iOS Device）
2. Organizer → **Distribute App** → App Store Connect → Upload
3. App Store Connect にアプリを作成（Bundle ID を合わせる）→ TestFlight タブで内部テスターを追加
4. 処理完了後、テスターの TestFlight アプリからインストール

※ アプリアイコンは仮のプレースホルダ（`Assets.xcassets/AppIcon.appiconset`）です。正式版で差し替えてください。
※ `ITSAppUsesNonExemptEncryption = false` 設定済みのため、TestFlight の輸出コンプライアンス質問はスキップされます。

### アプリ初回設定

1. ホーム → **設定** でサーバURL（`https://wester-visit-scanner.xxx.workers.dev`）と APIキーを入力
   - APIキーは Keychain 保存。**未設定でもスキャン・蓄積・CSV書き出しは動作**（スタンドアロン運用可）
2. ホーム → **スキャン開始** → イベント名・場所を入力（2回目以降は履歴からワンタップ）
3. 連続スキャン。読取OK=緑フラッシュ+効果音、対象外=赤、同一セッション内の再読取=黄「読取済み」
4. 同期は自動（オンライン復帰時・読取時）。手動は ホーム →「今すぐ同期」
5. CSVは 記録一覧 → 共有ボタン（全件 or セッション単位）

---

## 運用メモ

- **オフライン運用**: 機内モードでも読取→蓄積→CSV共有まで完結。回線復帰で未同期分（ホームに「未同期 n 件」バッジ）が自動送信される
- **重複について**:
  - 同一raw値の連写は3秒デバウンス
  - 同一セッション内の同一IDは既定でスキップ（設定で許可に変更可）
  - サーバは uuid 冪等のため、アプリの再送で重複レコードは増えない
- **画面表示**: 周囲の来場者から見えるため既定はマスク表示（`＊＊＊＊＊＊＊＊9881`）。設定で全桁表示に切替可
- **全データ削除**: 設定画面から2段階確認で実行（未同期分も消えるので注意）

## プライバシー切替点（本番移行時）

検証段階は会員IDを生のまま送信（HTTPS）。本番でハッシュ化する場合:

1. `ios/WesterVisitScan/Core/IDTransform.swift` の `transformID` を SHA-256(salt付き) 等へ差し替え
   （保存・送信・CSV出力はすべてこの関数を経由する設計）
2. `server/src/index.ts` の `WESTER_ID_RE` を出力形式に合わせて変更（例: `/^[0-9a-f]{64}$/`）
3. 既存の生IDデータの扱い（削除 or 変換）を運用判断

## 受け入れ基準との対応

| # | 基準 | 実装 |
|---|---|---|
| 1 | 機内モードで読取→蓄積→CSVが完結 | 読取・保存はローカル(SwiftData)のみで完結。CSVは共有シート出力 |
| 2 | 回線復帰で自動送信、再送で重複しない | NWPathMonitor + 指数バックオフ。サーバは uuid で INSERT OR IGNORE（ローカルD1で再送テスト済み） |
| 3 | `A328913579881A` → valid / `328913579881` 記録 | `classifyBarcode` + 単体テスト `testMeasuredWesterCardIsValid` |
| 4 | QR/Code128等 → 表示のみ・記録しない | 対象外は「WESTER会員証ではありません」表示のみ。単体テストあり |
| 5 | 同一セッション内の同一IDはスキップ | セッション内 seen 集合で判定し黄色「読取済み」表示（設定で許可可） |
| 6 | 再起動でデータ・設定・未同期状態を保持 | SwiftData永続化 + UserDefaults/Keychain |
| 7 | `classifyBarcode` / `transformID` の単体テスト | `ios/WesterVisitScanTests/`（XCTest） |
