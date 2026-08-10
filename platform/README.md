# 交通行動データ収集基盤（最小版）

行動研究のためのデータ収集基盤。ICOCA履歴ビューアではない。

将来 HealthKit（歩数・活動量）、GPS、アンケート、InBody、気象、GTFS などを
**同一の participant_id × timestamp 系**に載せて統合することを前提に、
その第一のデータソースとして交通系ICカード（ICOCA/FeliCa）の利用履歴を扱う。

Phase 1 の範囲は「iPhone を一切使わず、mock HEX で end-to-end を完成させる」こと。
iOS からの実読取は、mock と同じ `POST /v1/ingest` を叩くだけで載る。

- Cloudflare Workers + Hono + D1 + TypeScript
- テスト: Vitest（@cloudflare/vitest-pool-workers、本番と同じ migrations を流して実行）
- Web UI: Worker が配信する静的HTML + 素のJS（ビルド不要）

---

## 最重要の設計原則: 「受信した事実」と「解釈結果」の分離

| | テーブル | 性質 |
|---|---|---|
| 受信した事実 | `read_sessions` / `raw_observations` | **不変。絶対に消さない。重複していても全件保存** |
| 解釈結果 | `derived_transactions` | `parser_version` 付き。**いつでも全消し→再生成できる** |

サイバネ規格の履歴フォーマットや駅コード対応表の解釈は非公式情報に依存している。
生HEXが不変で残っていれば、解釈が v1 → v2 に変わっても全期間を再解析でき、
研究の再現可能性が担保できる。これは機能ではなく前提条件として扱っている。

具体的にコードへ落ちている点:

- `POST /v1/ingest` は生HEXを1件も捨てない。同じ生HEXが別セッションで届いたら、
  重複していても行が増える（「何回届いたか」も事実なので残す）。
  未使用ブロック（全0）も、16バイトでないHEXも、そのまま保存する。
- 唯一の例外は「HEXですらない文字列」。これは `raw_hex` 列の意味を壊すので保存せず、
  代わりにレスポンスで位置と理由を返す（端末側に残せる）。
- `derived_transactions` は `raw_observations` だけを入力に再構築される。
  `POST /v1/reparse` は全行 DELETE → 再生成で、テストで「削除しても同一内容に戻る」ことを検証している。
- 妥当性の判断は必ず解釈側（パーサ）で行う。受信側は判断しない。

### 転送レベルの冪等性は別の話

`session_id` はクライアント生成なので、通信リトライで同じ本文が2回届きうる。
これは「2回の受信」ではなく「1回の受信の再送」なので二重保存しない
（`status: "duplicate_session"` を返す）。
一方、**別セッションで同じ生HEXが届いた場合は必ず両方保存する**。
内容レベルの重複排除は解釈側の仕事であり、受信側では決してやらない。

---

## カード仮名と被験者

`card_pseudonym` は端末内 HMAC で生成されるため、
**アプリ再インストールや機種変更で同一カードでも値が変わる**。
よって対応表をサーバ側に持ち、1被験者に複数 pseudonym が紐づく状態を正常系として扱う。

- `POST /v1/ingest` に `participant_id` を付けると自動で紐付く（被験者が無ければ作成）。
- 既に別の被験者に紐付いている仮名を付け替えようとした場合は上書きせず 409。
- `GET /v1/transactions?participant_id=...` は被験者の全仮名を横断し、
  生HEXが同一の取引を1件に畳んで返す（`also_seen_as` にどの仮名でも見えたかが入る）。
  カード仮名単位で見たいときは `?card_pseudonym=...` を使う（畳まない）。

---

## パーサ（cybernetics-v1）

`src/parser/cybernetics_v1.ts`。16バイト固定長の履歴ブロックを解釈する。

```
 0     機器種別
 1     処理種別
 2     支払種別
 3     入出場種別
 4-5   年月日  YYYYYYYM MMMDDDDD（年は2000年からのオフセット）
 6-7   入場 線区/駅順   （物販系では時刻）
 8-9   出場 線区/駅順   （物販系では店舗/端末コード）
10-11  残額（リトルエンディアン, 円）
12-14  連番（24bit）
15     リージョン（地域）コード
```

- 全0のブロックは「カードの空き枠」として `blank`、それ以外で解釈できないものは
  理由付きの `unparsable`。どちらも例外を投げず、生データは残したまま読み飛ばす。
- 駅コードは `"AA-LL-SS"`（area-line-station を2桁大文字HEX）の1文字列で持つ。
  **area_code は v1 ではリージョンコード（offset 15）をそのまま使っている。**
  一般に流通している駅コード表の「エリアコード」との対応は公式には確定していないため、
  対応付けを変えるときは `PARSER_VERSION` を上げて再解析する前提にしてある。
- 物販系（70/73/74/75/198/203）は offset 6-7 が時刻なので、駅として解釈しない。

### 解釈を変えるときの手順

1. `src/parser/` を修正する
2. `PARSER_VERSION` を上げる（例: `cybernetics-v2`）
3. デプロイして `POST /v1/reparse`
4. `GET /v1/parser` の `stale` が 0 になったことを確認する

生HEXは触らないので、この操作で失われる情報はない。

### `transaction_key` の生成規則

`{card_pseudonym}:{raw_hex}`

生HEXそのものを鍵にしている。同じ取引を何度読み取っても内容が同じなので自然に
1行へ畳まれ（何回届いたかは raw 側に残る）、カード再発行で連番が巻き戻っても
別取引を上書きしない。ハッシュを使っていないので鍵から生データを目視で追える。

### `amount_estimated`（利用額の推定）

同一カード内を連番順に並べ、`直前レコードの残額 - 当レコードの残額` を入れる。
正なら減少（支払）、負なら増加（チャージ）。
**連番が連続していない箇所は `null`**（間に取得できていない取引があると、
差分が2件以上の合算になってしまうため）。名前のとおり推定値として扱うこと。

---

## セットアップ

```bash
cd platform
npm install

# 1) D1 を作成し、出力された database_id を wrangler.toml に貼る
npx wrangler d1 create mobility-datahub

# 2) スキーマ適用
npm run migrate:remote     # ローカルは npm run migrate:local

# 3) APIトークンを設定（openssl rand -hex 32 などで生成）
npx wrangler secret put API_TOKEN

npm run deploy
```

### ローカル開発

```bash
echo 'API_TOKEN=devtoken123' > .dev.vars   # gitignore 済み
npm run migrate:local
npm run seed:local                          # 暫定の駅マスタ（下記の注意を参照）
npm run dev                                 # http://localhost:8787
```

---

## mock HEX で end-to-end を通す

```bash
TOKEN=devtoken123

# 12件の履歴 + 空き枠 を持つカードを1枚生成して投入する
node tools/mock-hex.mjs --participant=P001 \
  | curl -sS -X POST http://localhost:8787/v1/ingest \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @-
# → {"status":"stored","stored_blocks":20,
#    "derived":{"rawRows":20,"uniqueBlocks":13,"derived":12,"blank":1,"unparsable":0}}

# 機種変更で仮名が変わった状況（同じ実カード・同じ履歴が別仮名で届く）
node tools/mock-hex.mjs --card=mockcard-a2-0000000000000000000000000000000 \
  --participant=P001 --start-date=2026-06-01 --start-seq=2000 --records=6 \
  | curl -sS -X POST http://localhost:8787/v1/ingest \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @-

curl -sS "http://localhost:8787/v1/transactions?participant_id=P001" -H "Authorization: Bearer $TOKEN"
```

ブラウザで <http://localhost:8787/> を開き、右上にトークンを入れると
ダッシュボード / 取引 / 生データ / 被験者・カード / mock投入 が使える。
「投入（mock）」タブに `tools/mock-hex.mjs` の出力をそのまま貼っても投入できる。

`tools/mock-hex.mjs` の主なオプション（`--records` `--start-seq` `--start-balance`
`--start-date` `--blank` `--session` など）はファイル冒頭のコメントを参照。
同じ `--session` を2回使うと再送（`duplicate_session`）の挙動を確認できる。

---

## API

| エンドポイント | 説明 |
|---|---|
| `GET /v1/health` | 疎通確認。認証不要 |
| `POST /v1/ingest` | 1回の読取セッションを受信。生HEXを全件保存し、そのカードの derived を再構築 |
| `GET /v1/sessions` | 読取セッション一覧（`?card_pseudonym=`） |
| `GET /v1/sessions/:id/raw` | そのセッションの生HEX全件 |
| `GET /v1/transactions` | 解釈結果（`?participant_id=` `?card_pseudonym=` `?from=` `?to=` `?limit=` `?offset=`） |
| `GET /v1/transactions.csv` | 同じ条件でCSV書き出し（BOM付きUTF-8） |
| `POST /v1/reparse` | derived を全消し→再生成（`?card_pseudonym=` で1枚だけも可） |
| `GET /v1/parser` | 現行 parser_version と、旧バージョンで作られた行数（`stale`） |
| `GET /v1/participants` / `POST /v1/participants` | 被験者の一覧・登録 |
| `POST /v1/participants/:id/cards` | カード仮名の紐付け |
| `GET /v1/cards` | 観測されたカード仮名（未割当を含む） |
| `GET /v1/station-master` / `POST /v1/station-master` | 駅コード対応表の参照・投入 |

`/v1/health` 以外は `Authorization: Bearer $API_TOKEN` が必要。

### ingest のペイロード

```jsonc
{
  "session_id": "クライアント生成のUUID",   // 再送はこの値で冪等になる
  "card_pseudonym": "端末内HMACの結果",
  "device_id": "任意",
  "read_at": "2026-08-09T21:00:00+09:00",  // 端末が付与した読取時刻
  "client_version": "ios/0.1.0",
  "participant_id": "P001",                // 任意。付ければ自動で紐付く
  "blocks": ["16010001...", "..."]         // 配列の index が block_order
}
```

キー名は **snake_case / camelCase のどちらでも受け付ける**
（`sessionId` `cardPseudonym` `deviceId` `readAt` `clientVersion` `participantId`）。
履歴ブロックの配列名は `blocks` / `records` の両方を受け付ける。
Swift の `JSONEncoder` が既定で camelCase を吐くためで、
キー名の違いで生データを落とすのは本末転倒という判断。

---

## 実機データで確認できたこと（v1 パーサ）

iOS プローブ（`ios-probe/0.1.0`）が読んだ実カード1枚・20ブロックで検証した結果。
検証に使った履歴そのものは個人の移動記録なのでリポジトリには含めていない。

**v1 の解釈が成り立っていること**

- 残額（offset 10-11 リトルエンディアン）と連番（offset 12-14）は整合していた。
  連番が連続する14区間すべてで、残額差分が運賃・物販・チャージとして妥当な額になる
  （チャージはちょうど 2000円 の増加、バスは 230円 など）。
- 処理種別は 運賃支払(1) / チャージ(2) / バス(15) / 物販(70) が実測で出現し、
  機器種別（改札機 0x16、車載端末 0x05、携帯電話 0x1B、自販機 0xC8、物販端末 0xC7）と
  矛盾しない組み合わせになっていた。

**分かった前提 / v2 の検討材料**

- **連番には欠番が出る。** 実測では連番 17〜41 の範囲で 20件しか保持されておらず、
  5件が欠けていた（カードの履歴枠に残らない取引がある）。
  `amount_estimated` を「連番が連続する区間だけ」に限定した設計はこの挙動に対応している。
  実データでも欠番の前後は正しく `null` になった。
- **リージョンバイト（offset 15）に `0xA0` が出る。** 改札・バスのレコードが `0xA0`、
  物販・チャージが `0x00` だった。v1 はこれをそのまま `area_code` に使うため
  駅コードが `A0-xx-xx` になる。一般に流通している駅コード表のエリア区分は
  この値域ではないので、正規の対応表を入れる段階で対応付けを決め直し、
  `PARSER_VERSION` を上げて再解析する必要がある。
- **物販系の offset 6-7 は時刻として読める。** 5bit(時) + 6bit(分) と解釈すると
  実データで妥当な時刻（昼・夕方など）になった。**履歴の中で唯一、時刻が取れるレコード種別。**
  現行スキーマに時刻列がないため保存していない。行動研究として分単位が要るなら、
  スキーマに列を足して `PARSER_VERSION` を上げる判断が必要。
- **チャージ・バスのレコードでも offset 6-9 は駅コードではない可能性が高い。**
  v1 は物販系だけを駅の解釈から除外しているが、実測ではモバイルチャージ(機器 0x1B)の
  offset 6-7 に駅らしくない固定値が入っていた。除外条件の見直しは v2 の候補。

---

## 駅コードマスタについての注意

`seeds/station_master.mock.sql` に入っているコードは **実在の駅コードではない**。
mock HEX と対にした暫定値で、「駅名が出る／出ない経路が通っていること」を
確認するためだけのもの。**実運用では正規の対応表（近畿圏優先）を投入すること。**

```bash
curl -X POST http://localhost:8787/v1/station-master \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"csv":"01,2E,01,JR西日本,大阪環状線,大阪\n01,2E,05,JR西日本,大阪環状線,京橋"}'
```

マスタ未収載のコードは、推測で駅名を作らずコードのまま表示する
（UI では色を変えて「未収載」と分かるようにしてある）。
mock には意図的に未収載のコード `01-2E-13` が混ぜてある。

---

## テスト

```bash
npm test        # Vitest（Workers ランタイム上で、本番と同じ migrations を適用して実行）
npm run typecheck
```

主に次を検証している:

- パーサ: 組み立て↔解釈の往復、残額のリトルエンディアン、日付ビットの境界、
  未使用ブロック、物販を駅として解釈しないこと、壊れた入力が例外を投げないこと
- 受信: 生HEXを全件保存すること、別セッションの重複を残すこと、
  同一 session_id の再送で増えないこと、非HEXだけを弾いて残りは保存すること
- 解釈: 連番が飛んでいる区間の利用額を推定しないこと、`first_session_id` が
  再解析でぶれないこと、**derived を全消ししても生HEXから同一内容に戻ること**
- カード仮名: 1被験者に複数仮名、被験者単位での重複統合、付け替えの拒否

履歴ブロックの組み立ては `tools/lib/encode.mjs` の1箇所だけに置き、
mock 生成ツールとテストで共有している（実装が2つに分かれると、
パーサのバグをテストが同じバグで打ち消してしまうため）。

---

## Phase 1 で意図的にやっていないこと

次の担当者が判断できるよう、未着手の理由も含めて残しておく。

- **iOS クライアント**: Phase 1 の範囲外。サーバ側は `POST /v1/ingest` で受け入れ済みで、
  実機プローブが吐く camelCase + `records` 形式もそのまま通ることを確認している。
  端末側は「HMACで仮名を作る」「20ブロック読む」「session_id を採番して再送する」だけでよい。
- **area_code と正規の駅コード表の対応付け**: v1 はリージョンコードをそのまま使っている。
  実機では `0xA0` が観測されており（上記「実機データで確認できたこと」参照）、
  正規の対応表を入れる段階で決め直し、`PARSER_VERSION` を上げて再解析する。
- **時刻**: 履歴ブロックは日付までしか持たない。物販系のみ offset 6-7 が時刻で、
  実機データでも妥当な時刻として読めることを確認したが、スキーマに列がないため保存していない。
  鉄道・バスの分単位の行動を扱うには GPS / HealthKit 側の timestamp と突き合わせる必要がある。
- **他データソース**: participants を独立テーブルにしてあるので、
  `participant_id × timestamp` を持つテーブルを足していけば載る。
- **参照系の認証**: 単一の Bearer トークン。複数人で使うなら Cloudflare Access
  など（同リポジトリの `server/` が先例）へ寄せる。
