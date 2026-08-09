# デプロイ手順（Cloudflare Pages + Access + Worker/D1）

複数端末で集計する構成を立ち上げる手順。**Cloudflareアカウントでの操作が必要なため、
この作業は人が行う。** 所要 30〜40分。

前提: Cloudflareアカウント（無料枠で足りる）、Node.js 18+。

## 現在の状態（2026-08-09 時点）

| 手順 | 状態 | 実際の値 |
| --- | --- | --- |
| 1. D1 | 完了 | `wester-visit-scanner`（APAC/東京）。マイグレーション 0001・0002 適用済み |
| 2. Worker | 完了 | `https://wester-visit-scanner.kikkaku.workers.dev`（`API_KEY` 設定済み） |
| 3. Pages | 完了 | `https://wester-checkin.pages.dev` |
| 4. ALLOWED_ORIGINS | 完了 | `https://wester-checkin.pages.dev` |
| 5. Access | **未実施** | これが済むまでアプリは誰でも開ける状態 |
| 6. 動作確認 | 未実施 | 手順5の完了後に行う |

**手順5が終わるまで同期は動かない。** Worker は Access も `API_KEY` も無いリクエストを
拒否するため（`isWebappAuthorized`）、ブラウザからの同期は 401 になる。アプリは
ローカル保存のみで動作する。設定漏れで全公開にならないよう、既定を拒否側に倒してある。

構成は次のとおり。

```
  スマホ(受付)  ──HTTPS──▶  Cloudflare Pages（アプリ本体）
                                  │ Access で関係者に限定
                                  ▼
                            Worker（/v1/wc/sync）──▶ D1（集計データ）
```

アプリは資格情報を持たない。Access が認証済みリクエストに付けるJWTを
Worker側で検証する。このため、URLを知られてもデータは読めない。

---

## 1. D1 データベースを作る

```bash
cd server
npx wrangler login          # ブラウザが開くので許可する
npx wrangler d1 create wester-visit-scanner
```

出力される `database_id` を `server/wrangler.toml` の
`REPLACE_WITH_D1_DATABASE_ID` に貼り付ける。

```bash
npm run migrate:remote      # 本番D1にテーブルを作成
```

## 2. Worker をデプロイする

```bash
cd server
npx wrangler secret put API_KEY        # iOSアプリ用。任意の長い文字列を入力
npm run deploy
```

デプロイ後に表示される URL（例 `https://wester-visit-scanner.<account>.workers.dev`）を控える。
以降これを **WORKER_URL** と呼ぶ。現在の値は
`https://wester-visit-scanner.kikkaku.workers.dev`。

> 初回は `You need to register a workers.dev subdomain` で失敗する。
> アカウントに workers.dev のサブドメインがまだ無いため。取得済みなら不要だが、
> 未取得なら先に一度だけ次を実行する（このアカウントは `kikkaku` を取得済み）。
>
> ```bash
> curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
>   -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
>   -H "Content-Type: application/json" --data '{"subdomain":"kikkaku"}'
> ```

疎通確認:

```bash
curl "$WORKER_URL/v1/health"           # {"ok":true} が返る
curl "$WORKER_URL/v1/wc/sync"          # {"error":"unauthorized"} が返れば正常
```

2つ目が `unauthorized` にならず中身が返る場合は設定が誤っている。**先に進まないこと。**

## 3. アプリを Cloudflare Pages に載せる

```bash
cd webapp
npm run deploy:init                    # 初回のみ（プロジェクト作成）
VITE_SYNC_URL="$WORKER_URL" npm run deploy -- --branch main
```

表示される URL（例 `https://wester-checkin.pages.dev`）を控える。
以降これを **APP_URL** と呼ぶ。現在の値は `https://wester-checkin.pages.dev`。

> `VITE_SYNC_URL` を付け忘れるとローカル保存のみのアプリになる。
> 画面右上のバッジが「ローカル保存のみ」でないことで確認できる。

> `--branch main` を付けないと、チェックアウト中のGitブランチ名がそのまま使われ、
> `https://<hash>.wester-checkin.pages.dev` のプレビュー環境に出る。
> 本番URL（**APP_URL**）は更新されないので注意する。

## 4. Worker に許可オリジンを設定する

ブラウザから別オリジンのWorkerを呼ぶため、明示的な許可が要る。

```bash
cd server
npx wrangler secret put ALLOWED_ORIGINS
# 入力例: https://wester-checkin.pages.dev
```

設定済みの値は `https://wester-checkin.pages.dev`（本番のみ）。プレビュー環境の
`https://<hash>.wester-checkin.pages.dev` は含めていないため、プレビューからは同期できない。

## 5. Cloudflare Access で関係者に限定する

**ここが未実施の残作業。** 済むまでアプリは URL を知る誰でも開ける。

Zero Trust ダッシュボード（`one.dash.cloudflare.com`）で、**アプリとWorkerの両方**に
同じポリシーをかける。片方だけだと素通しの経路が残る。

APIトークンで自動化する場合は `Access: Apps and Policies` の Edit 権限が要る。
Workers系の権限だけのトークンでは `/access/organizations` が 10000 Authentication error
になり、この手順は実行できない。

### 5-1. アプリ側

1. Access → Applications → Add an application → **Self-hosted**
2. Application domain: **APP_URL** のドメイン（例 `wester-checkin.pages.dev`）
3. Policy: Action=**Allow**、Include に受付スタッフのメールアドレス
   （または `Emails ending in @自社ドメイン`）
4. 保存

### 5-2. Worker 側

1. 同様に Add an application → Self-hosted
2. Application domain: **WORKER_URL** のドメイン
3. Policy: 5-1 と同じ内容
4. 保存後、アプリケーションの詳細に表示される **Audience (AUD) タグ** を控える

### 5-3. Worker に Access の検証設定を入れる

```bash
cd server
npx wrangler secret put ACCESS_TEAM_DOMAIN
# 入力例: your-team.cloudflareaccess.com （Zero Trust の Settings → Custom Pages 等に表示）

npx wrangler secret put ACCESS_AUD
# 5-2 で控えた AUD タグ
```

これを設定すると、Worker は Access を経由しないリクエストを拒否するようになる。

## 6. 動作確認

1. スマホで **APP_URL** を開く → メール宛のワンタイムPIN入力を求められる
2. ログイン後、イベントを作成してチェックインを1件記録する
3. **別のスマホ**で同じURLを開き、同じイベントの件数が増えていることを確認する

反映は最大20秒（定期同期の間隔）。画面を切り替えて戻ると即座に更新される。

---

## 注意点

**`DEV_OPEN_WC_SYNC` は本番で絶対に設定しない。** これはローカル開発用に
認証を素通しにする変数で、`server/.dev.vars`（gitignore済み）にのみ書く。
本番に設定すると同期APIが無認証で公開される。

**2台目以降で読み取るには、管理画面から引き継ぎが要る。**
ハッシュのソルトはサーバに送っていない（サーバに置くと12桁が総当たりで
探索可能になり、ハッシュ化の保護がほぼ無くなるため）。同期だけで取り込んだ
イベントは集計は見えるが読み取りができない。次の手順で引き継ぐ。

1. 1台目で対象イベントの「管理」→「受付を増やす」→「他の端末を追加する」
2. 表示されたQRを、2台目の**標準のカメラアプリ**で写す
3. 出てきたリンクを開くと「この端末で受付できます」と表示され、読み取り可能になる

リンクにはソルトが含まれる。ソルトはURLのフラグメント（#以降）にあるため
HTTPリクエストとしてサーバへ送信されないが、ブラウザ履歴やスクリーンショットには
残る。**関係者以外に共有しないこと。**

**GitHub Pages 版について。** 実機確認用に `https://uto92.github.io/inforadar/` でも
公開している（`main` の `docs/`）。こちらはアクセス制限が無く同期先も未設定のため、
**本番運用には使わない**。混乱を避けるなら Pages 移行後に公開を停止する
（Settings → Pages → Source を None にする）。

## ロールバック

```bash
cd server && npx wrangler rollback      # Worker を直前のバージョンへ
```

Pages は ダッシュボード → Deployments から任意のデプロイを Rollback できる。
D1 のデータはロールバックされないため、スキーマ変更を伴う場合は
`npx wrangler d1 export wester-visit-scanner --remote --output backup.sql` で
先に控えておく。
