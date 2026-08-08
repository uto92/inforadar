# WESTER来場チェックイン（webapp）

イベント・店舗施策の実証用に、WESTER会員証のバーコードをスマホカメラで読み取り、
来場（チェックイン）を記録・集計する軽量Webアプリ。**受付スタッフのスマホ1台**で運用できる。

- Vite + React + TypeScript / バーコード読取は **Quagga2**（Codabar / Code128 / Code39 / EAN / ITF / UPC）
- **オフラインファースト**: 記録は常に IndexedDB（Dexie）へ即時保存。Supabase は環境変数を設定したときだけ有効になる後付けの同期先
- **会員IDの生値は保存しない**: イベントごとのソルト付きSHA-256ハッシュのみ保存（CSVもハッシュのみ）
- デジタル庁デザインシステム（DADS β）準拠の白背景＋高コントラストUI、Noto Sans JP バンドル

> 実測に基づく注意: WESTER会員証の物理カードは **Codabar (NW-7)**（例 `A328913579881A`）。
> ガード文字を除いた **数字12桁** が会員ID。Code128 等で同じ12桁が来ても受け付ける。
> 判定ロジックは `src/lib/normalize.ts` に集約。
>
> **読取ライブラリの選定理由**: 当初 html5-qrcode を使ったが実機で全く読み取れなかった。
> 同一のCodabar画像で比較したところ html5-qrcode(ZXing系)=失敗 / Quagga2=成功 となり、
> ZXing系はCodabarを実質的に読めないと判明したため Quagga2 に移行した。
> 再発防止の総合テストが `npm run test:scan`（実バーコード映像を仮想カメラに流し込む）。

## 画面構成

| パス | 画面 | 内容 |
|---|---|---|
| `/` | イベント選択 | イベント名・開催日・会場を事前登録。当日はカードの「スキャン開始」を押すだけ |
| `/scan/:id` | スキャン | 「読み取り」押下時のみ読取→チェックイン（読取音＋バイブ＋全画面フィードバック）。押していない間の読取は破棄。手入力（末尾6桁）フォールバック付き |
| `/admin/:id` | 管理 | リアルタイム来場数、時間帯別ヒストグラム、CSVエクスポート（来場記録/エラーログ）、手動同期 |
| `/notice/:id` | 掲示文 | 収集目的の受付掲示テンプレート（イベント名自動差し込み、印刷・コピー対応） |

## セットアップ

前提: Node.js 18+

```bash
cd webapp
npm install
npm run dev        # http://localhost:5173 （PCのブラウザ + Webカメラで動作確認可）
npm run build      # 型チェック + 本番ビルド（dist/）
```

## 公開範囲とアクセス制限（デプロイ前に必ず読む）

**`https://xxx.pages.dev` はインターネット上に公開される。** URLを知っている人は誰でも開ける。
かつ、TLS証明書の透明性ログ（crt.sh 等）にホスト名が記録されるため、
「URLを教えなければ見つからない」とは考えないこと。検索エンジン除けは
`public/robots.txt` と `<meta name="robots" content="noindex">` で入れてあるが、
これはアクセス制限ではない。

段階ごとの実際のリスクは次のとおり:

| 段階 | 第三者がURLを開くと何が見えるか |
|---|---|
| Supabase未設定（カメラ実機テスト） | **空のアプリだけ。**記録は各端末のブラウザ内(IndexedDB)にしかないため、来場データは一切見えない |
| Supabase設定後 | anonキーがJSバンドルに含まれるため、**パイロットRLSでは来場データ(ハッシュ値)を読み取れる。** 書換・削除は不可 |

したがって **Supabaseを繋ぐ前に Cloudflare Access をかける**のが実務上の分岐点になる。

### Cloudflare Access で関係者だけに限定する（無料枠50ユーザーまで）

1. Cloudflareダッシュボード → Zero Trust → Access → Applications → Add an application → Self-hosted
2. Application domain に Pages のドメイン（例 `wester-checkin.pages.dev`）を指定
3. Policy: Action=Allow、Include に受付スタッフのメールアドレス（または
   `Emails ending in @自社ドメイン`）を指定
4. 保存後にURLを開くと、メール宛のワンタイムPINによる認証が入るようになる

スタッフの初回だけメール認証が必要になるが、セッションは維持されるので当日の運用は妨げない。

## 実機検証（スマホでの確認）

TestFlight等は不要。カメラ（getUserMedia）は `localhost` 以外では **HTTPS必須** のため、
HTTPSのURLを用意してiPhoneのSafariで開くだけでよい。

**公開先: GitHub Pages（`main` の `docs/` を配信）**

```
https://uto92.github.io/inforadar/
```

ビルド済みの成果物を `docs/` にコミットしてある（`npm run build:pages` で生成）。
リポジトリ設定で一度だけ次を設定すると公開される:

  Settings → Pages → Source: `Deploy from a branch` / Branch: `main` / Folder: `/docs`

※ Actions から Pages を自動有効化する方法も試したが、Pagesサイトの新規作成は
   リポジトリ管理者の操作が必要で `GITHUB_TOKEN` では実行できない
   （`Create Pages site failed: Resource not accessible by integration`）。
   このため初回の有効化だけは手動になる。

アプリを更新したときは `npm run build:pages` で `docs/` を再生成してコミットすれば、
push と同時に再公開される。

**別ルート: Cloudflare Pagesへ直接アップロード**（Git連携不要・Supabase未設定でも動く）

```bash
cd webapp
npx -y wrangler login      # 未ログインの場合のみ
npm run deploy:init        # 初回のみ（Pagesプロジェクト作成）
npm run deploy             # ビルド + アップロード
```

出力される `https://wester-checkin.pages.dev` をiPhoneのSafariで開く。
プロジェクト名を変えたい場合は package.json の `deploy` スクリプトの
`--project-name` を変更する。

**開発ループ（コードを直しながら実機で見る）**

```bash
cd webapp && npm run dev
# 別ターミナルで（cloudflaredは brew install cloudflared 等で導入）
cloudflared tunnel --url http://localhost:5173
```

表示される `https://xxx.trycloudflare.com` をiPhoneで開く（HMR有効）。
トンネルドメインのHost許可は `vite.config.ts` の `allowedHosts` で設定済み。

**実機での確認ポイント**

1. 実カードのCodabar読取（最重要）。赤「対象外」= デコードは成功して12桁規則で弾かれた
   （管理画面のエラーログCSVの `symbology` 列で追える）／無反応 = デコード失敗
   （距離10〜15cm・明るさ・横長枠への位置合わせを調整）
2. 読取音はマナーモード解除が必要。バイブはiOS Safariでは動かない（仕様）
3. 機内モードでチェックイン → 復帰 → 未送信バッジが消える（Supabase設定時）
4. 直射日光下での視認性とカメラ露出
5. 「ホーム画面に追加」で運用する場合はSafari本体とストレージが別になるため、
   どちらか一方に統一して使う

## Supabase 設定（同期を有効にする場合）

未設定でも全機能がローカルで動く。設定すると自動同期が有効になる。

1. Supabaseでプロジェクト作成 → SQL Editor で **`supabase/schema.sql`** を実行
   （events / checkins / scan_errors テーブルと、anonロールに select/insert のみ許可する
   パイロット用RLSが作成される。update/delete ポリシーは作らないため改ざん・削除は不可）
2. 環境変数を設定（ローカルは `.env.local`、Pagesはダッシュボードの環境変数）:

```bash
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...   # Project Settings → API の anon public キー
```

同期の仕組み: 各レコードはクライアント生成UUIDが主キーで、`onConflict: id` +
ignoreDuplicates の upsert により**再送しても重複しない**。送信順は events → checkins →
scan_errors（FK順）。失敗時は指数バックオフ（2, 4, 8…最大300秒）で自動リトライ。
オンライン復帰イベントと書き込み検知（liveQuery）でも自動起動する。

## Cloudflare Pages デプロイ

1. リポジトリを接続して新規Pagesプロジェクト作成
2. 設定: **Root directory** `webapp` / **Build command** `npm run build` / **Build output** `dist`
3. （同期する場合）環境変数 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を設定
4. SPAルーティングは `public/_redirects`（`/* /index.html 200`）で対応済み

## 当日運用手順

**前日まで**
1. イベント選択画面で「新規イベント登録」（イベント名・開催日・会場）
2. 掲示文画面を開き、管理者・問い合わせ先を差し替えたうえで印刷して受付に掲示
   （文面の雛形は `src/pages/NoticePage.tsx` のプレースホルダ定数）
3. 受付スマホの設定: 画面の明るさ最大・自動ロックを長めに・マナーモード解除
4. 一度現地でアプリを開いておく（初回ロードをキャッシュ。以降は圏外でも記録可能）

**当日**
1. イベントカードの「スキャン開始」→「カメラを開始」→ カメラ許可
2. 会員証バーコードを枠内に。**緑=チェックイン / 黄=チェックイン済 / 赤=対象外**
   （2m先からも分かる全画面表示。読取音は端末の消音解除が必要）
3. カメラで読めない場合は「手入力（末尾6桁）」。末尾一致の警告が出た場合、
   別人と確認できたら「別人として記録する」
4. 電波がなくても記録は継続される（右上バッジに未送信件数が表示される）

**終了後**
1. 管理画面で来場数・時間帯別ヒストグラムを確認
2. 「来場記録CSV」「エラーログCSV」をエクスポート（BOM付きUTF-8、Excelでそのまま開ける）
3. Supabase設定時は未送信0件（「同期済み」バッジ）を確認してから端末を片付ける

## データとプライバシー

- イベント作成時に乱数ソルトを生成し、会員IDは読取と同時に
  `SHA-256(salt:会員ID)` へ変換。**生のIDはメモリ上でのみ扱い、どこにも保存しない**
- 手入力用に `SHA-256(salt:sfx:末尾6桁)` も併存させ、スキャン⇔手入力間の重複照合に使う
  （末尾6桁の生値も保存しない）
- CSVエクスポートにもハッシュ値のみ出力される
- 本番でさらに強度を上げる場合も、変更点は `src/lib/hash.ts` と `src/lib/normalize.ts` に閉じている

## 既知の制約

1. **iOS Safariのカメラ権限**: HTTPS必須・「カメラを開始」などユーザー操作起点でのみ起動。
   一度「許可しない」を選ぶと、アドレスバーの「ぁあ」→Webサイトの設定（またはiOS設定→Safari）
   から再許可が必要。アプリ切替や画面ロックでカメラが止まった場合は「カメラを再起動」を押す
2. **バイブはiOS非対応**（`navigator.vibrate` が存在しない）。読取音＋全画面色で代替。
   読取音はマナーモード解除が必要
3. **IndexedDBの揮発リスク**: Safariは「履歴とWebサイトデータを消去」やITP（約7日間未使用）で
   ストレージを削除することがある。**当日中のCSVエクスポート or Supabase同期を必須運用とする**こと。
   プライベートブラウズでは使用しない
4. **ハッシュは仮名化であり匿名化ではない**: 会員IDは12桁の数値空間のため、ソルトを知る者は
   総当たりで復元可能。ソルトはイベント行と共に保存される設計（照合に必要なため）であり、
   「生値をそのまま持たない」ことが目的。匿名加工情報としての扱いはできない
5. **anonキー運用のRLS**: パイロット設定ではURL＋anonキーを知る者はデータを閲覧できる
   （閲覧できるのはハッシュ値のみ）。書き換え・削除は不可。本番は Supabase Auth 導入のうえ
   ポリシーを `to authenticated` へ差し替える（`supabase/schema.sql` 内コメント参照）
6. **複数端末での同時運用は想定外**: 重複判定は端末ローカルで行うため、複数台で同一イベントを
   さばくと端末間の重複は検知されない（サーバ側のユニーク制約が同期時に吸収はする）
7. **html5-qrcode はメンテ頻度が低い**（2.3.8, 2023年〜）。読取ロジックは
   `src/lib/normalize.ts` に隔離してあり、ライブラリ差し替えの影響範囲は ScanPage のみ
8. **1Dバーコード（Codabar/Code128）の読取条件**: 逆光・カード面の反射・暗所に弱い。
   屋外では日陰を作る、カードを画面の横長枠に合わせる、といった運用でカバーする
9. **連写抑止**: 同一コードは2.5秒のクールダウンがあるため、同一人物の連続再読取は
   その間無視される（重複警告も出ない）
10. **CSVダウンロード（iOS Safari）**: ダウンロードは共有シート/ファイルAppに保存される。
    Excelで開く場合はBOM付きUTF-8のためそのまま文字化けしない
