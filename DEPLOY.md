# デプロイ手順（Cloudflare Pages + Access + Worker/D1）

複数端末で集計する構成を立ち上げる手順。**Cloudflareアカウントでの操作が必要なため、
この作業は人が行う。** 所要 30〜40分。

前提: Cloudflareアカウント（無料枠で足りる）、Node.js 18+。

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

デプロイ後に表示される URL（例 `https://visit-checkin.<account>.workers.dev`）を控える。
以降これを **WORKER_URL** と呼ぶ。

疎通確認:

```bash
curl "$WORKER_URL/v1/health"           # {"ok":true} が返る
curl "$WORKER_URL/v1/wc/sync"          # {"error":"unauthorized"} が返れば正常
```

2つ目が `unauthorized` にならず中身が返る場合は設定が誤っている。**先に進まないこと。**

## 3. アプリの公開（Workerに統合済み）

アプリ本体はWorkerの静的アセットとして同じURLから配信される
（`server/wrangler.toml` の `[assets]`）。個別のホスティングは不要で、
更新は次の1コマンド（スタッフ面と公開面の両Workerをデプロイする）:

```bash
cd webapp && npm run deploy
```

### 公開面（visit-self）について

来場者セルフチェックイン用の公開Worker（`server/wrangler.self.toml`）。
**意図的にAccessをかけない**（来場者が開くページのため）。代わりに:

- 秘密を一切持たない（ソルト・APIキーはこのWorkerに存在しない）
- 書き込めるのは「セルフ受付」を許可した場所へのチェックインだけ
- 身元は端末仮名（ブラウザ内の乱数）。カード読取は公開面では行わない

Accessの対象は**スタッフ面（visit-checkin）だけ**でよい。

> 旧構成の Cloudflare Pages（wester-checkin.pages.dev）は削除済み。
> Accessで保護できないURLのため、再作成しないこと。

## 4. （廃止）許可オリジン設定

アプリとAPIが同一オリジンになったため CORS 設定は不要。
`ALLOWED_ORIGINS` は別オリジンから叩く構成に戻す場合のみ設定する。

## 5. Cloudflare Access で関係者に限定する

Zero Trust ダッシュボード（`one.dash.cloudflare.com`）で、**アプリとWorkerの両方**に
同じポリシーをかける。片方だけだと素通しの経路が残る。

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
