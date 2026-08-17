#!/usr/bin/env bash
# 公開面(visit-self)の検証。ローカルで実行する。
#
#   npm run migrate:local
#   npx wrangler dev --port 8787 --local                         # 別ターミナル
#   npx wrangler dev -c wrangler.self.toml --port 8788 --local   # 別ターミナル
#   ./test/self-api.sh
#
# 前提: ローカルD1にイベントと場所が1件以上あること（test/sync-api.sh を先に実行）。
# 名前空間の検証(§9)だけはスタッフ面のAPIにも書き込むため 8787 も要る。
set -u
BASE="${SELF_BASE:-http://localhost:8788}"
API="${API_BASE:-http://localhost:8787}/v1/wc/sync"
KEY="${1:-$(sed -n 's/^API_KEY=//p' "$(dirname "$0")/../.dev.vars")}"
H="Authorization: Bearer $KEY"
hex() { python3 -c "import secrets;print(secrets.token_hex(32))"; }
uuid() { python3 -c "import uuid;print(uuid.uuid4())"; }
SQL() { npx wrangler d1 execute wester-visit-scanner --local --json --command "$1" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d[0]['results'],ensure_ascii=False))"; }
EV=$(SQL "SELECT id FROM wc_events ORDER BY received_at DESC LIMIT 1" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
PL=$(SQL "SELECT id FROM wc_places ORDER BY received_at DESC LIMIT 1" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
SQL "UPDATE wc_places SET self_enabled = 1 WHERE id = '$PL'" > /dev/null
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS: $1"; pass=$((pass+1)); else echo "  FAIL: $1（期待 $3 / 実際 $2）"; fail=$((fail+1)); fi }

BODY=$(curl -s --noproxy '*' "$BASE/p/$EV/$PL")
check "掲示ページが表示される" "$(echo "$BODY" | grep -c 'チェックインする')" "1"
check "取得しない情報の説明がある" "$(echo "$BODY" | grep -c '一切取得しません')" "1"
# 公開面にソルトが漏れていないこと（DESIGN.md の最重要制約）
check "ページに32hexの断片が無い" "$(echo "$BODY" | grep -cE '[0-9a-f]{32}')" "0"

PSEUDO=$(hex)
R1=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$PSEUDO\"}")
check "1回目 = stored" "$R1" '{"status":"stored"}'
R2=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$PSEUDO\"}")
check "2回目（同一端末） = already" "$R2" '{"status":"already"}'

SQL "UPDATE wc_places SET self_enabled = 0 WHERE id = '$PL'" > /dev/null
check "無効化した場所のページは404" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/p/$EV/$PL")" "404"
R3=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$(hex)\"}")
check "無効化した場所へのPOSTは拒否" "$R3" '{"status":"error"}'
R4=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"deadbeef-dead-4ead-8ead-deadbeefdead\",\"pseudonym\":\"$(hex)\"}")
check "実在しない場所へのPOSTは拒否" "$R4" '{"status":"error"}'
SQL "UPDATE wc_places SET self_enabled = 1 WHERE id = '$PL'" > /dev/null

# ---- 仮名の名前空間分離（DESIGN.md §3「段が違えば名前空間を分ける」） ----
#
# /self/checkin は認証なしで任意の64hexを受け付ける。端末仮名をそのまま
# member_hash に入れると、カード/NFCの仮名空間と同じ列・同じ一意制約を
# 共有してしまい、公開面から2つの操作ができてしまう。
# self.ts は "self:" を前置してSHA-256で写像することでこれを塞ぐ。
echo "9) 仮名の名前空間分離"
scan_push() { # $1=memberHash → stored.checkins を返す
  curl -s --noproxy '*' -X POST "$API" -H "$H" -H 'Content-Type: application/json' -d "{
    \"checkins\":[{\"id\":\"$(uuid)\",\"eventId\":\"$EV\",\"memberHash\":\"$1\",\"suffixHash\":\"$(hex)\",
      \"method\":\"scan\",\"checkedInAt\":\"2026-08-13T10:00:00.000Z\",\"deviceId\":\"devNS\"}]}" \
    | grep -o '"checkins":[0-9]*' | head -1 | grep -o '[0-9]*$'
}
self_post() { # $1=pseudonym → {"status":...}
  curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$1\"}"
}

# (1) 出席オラクル: 他人のカード仮名を投げて "already" が返れば、
#     そのイベントへの来場有無を認証なしに照会できてしまう
CARD=$(hex)
check "前提: カード読取が登録される" "$(scan_push "$CARD")" "1"
check "他人のカード仮名を投げても来場の有無が漏れない" "$(self_post "$CARD")" '{"status":"stored"}'

# (2) 先回り妨害: 既知のカード仮名を先に公開面から入れておくと、
#     本物のスタッフ読取が (event_id, member_hash) の一意制約で捨てられる
CARD2=$(hex)
check "先に公開面へ同じ値を入れる" "$(self_post "$CARD2")" '{"status":"stored"}'
check "本物のスタッフ読取は捨てられない" "$(scan_push "$CARD2")" "1"
# 写像されていれば、公開面が書いた行の member_hash は投げた値と一致しない
check "生の仮名のままでは保存されない" \
  "$(SQL "SELECT COUNT(*) c FROM wc_checkins WHERE member_hash='$CARD2' AND method='self'" | grep -o '"c": *[0-9]*' | grep -o '[0-9]*$')" "0"

echo; echo "結果: PASS $pass / FAIL $fail"
[ "$fail" -eq 0 ]
