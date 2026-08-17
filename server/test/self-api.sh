#!/usr/bin/env bash
# 公開面(visit-self)の検証。ローカルで実行する。
#
#   npm run migrate:local
#   npx wrangler dev -c wrangler.self.toml --port 8788 --local   # 別ターミナル
#   ./test/self-api.sh
#
# 前提: ローカルD1にイベントと場所が1件以上あること（test/sync-api.sh を先に実行）。
set -u
BASE="${SELF_BASE:-http://localhost:8788}"
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

PSEUDO=$(python3 -c "import secrets;print(secrets.token_hex(32))")
R1=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$PSEUDO\"}")
check "1回目 = stored" "$R1" '{"status":"stored"}'
R2=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$PSEUDO\"}")
check "2回目（同一端末） = already" "$R2" '{"status":"already"}'

SQL "UPDATE wc_places SET self_enabled = 0 WHERE id = '$PL'" > /dev/null
check "無効化した場所のページは404" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/p/$EV/$PL")" "404"
R3=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"$PL\",\"pseudonym\":\"$(python3 -c "import secrets;print(secrets.token_hex(32))")\"}")
check "無効化した場所へのPOSTは拒否" "$R3" '{"status":"error"}'
R4=$(curl -s --noproxy '*' -X POST "$BASE/self/checkin" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"placeId\":\"deadbeef-dead-4ead-8ead-deadbeefdead\",\"pseudonym\":\"$(python3 -c "import secrets;print(secrets.token_hex(32))")\"}")
check "実在しない場所へのPOSTは拒否" "$R4" '{"status":"error"}'
SQL "UPDATE wc_places SET self_enabled = 1 WHERE id = '$PL'" > /dev/null

echo; echo "結果: PASS $pass / FAIL $fail"
[ "$fail" -eq 0 ]
