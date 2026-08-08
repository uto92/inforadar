#!/usr/bin/env bash
# webapp同期APIの検証。ローカルのWorkerに対して実行する。
#
#   npm run migrate:local
#   npx wrangler dev --port 8787 --local     # 別ターミナル
#   ./test/sync-api.sh "$(sed -n 's/^API_KEY=//p' .dev.vars)"
#
# 実行ごとに一意なIDを使うためDBのリセットは不要。
set -u
KEY="$1"
API="${API_BASE:-http://localhost:8787}/v1/wc/sync"
H="Authorization: Bearer $KEY"
# 実行ごとに一意なIDを使う（前回データの影響を受けないように）
R=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')
EV="11111111-1111-4111-8111-1111${R}"
C1="22222222-2222-4222-8222-2222${R}"
C2="33333333-3333-4333-8333-3333${R}"
C3="44444444-4444-4444-8444-4444${R}"
C4="55555555-5555-4555-8555-5555${R}"
HASH_A=$(printf 'a%.0s' {1..56})${R}
HASH_B=$(printf 'b%.0s' {1..56})${R}
SUF=$(printf 'c%.0s' {1..56})${R}
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS: $1"; pass=$((pass+1)); else echo "  FAIL: $1（期待 $3 / 実際 $2）"; fail=$((fail+1)); fi }

echo "1) 認証"
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$API" -d '{}')
check "認証なしは401で拒否" "$code" "401"

echo "2) 新規登録"
r=$(curl -s --noproxy '*' -X POST "$API" -H "$H" -H 'Content-Type: application/json' -d "{
  \"events\":[{\"id\":\"$EV\",\"name\":\"テスト会\",\"eventDate\":\"2026-08-08\",\"venue\":\"社内\",\"deviceId\":\"devA\",\"createdAt\":\"2026-08-08T10:00:00.000Z\"}],
  \"checkins\":[
    {\"id\":\"$C1\",\"eventId\":\"$EV\",\"memberHash\":\"$HASH_A\",\"suffixHash\":\"$SUF\",\"method\":\"scan\",\"checkedInAt\":\"2026-08-08T10:01:00.000Z\",\"deviceId\":\"devA\"},
    {\"id\":\"$C2\",\"eventId\":\"$EV\",\"memberHash\":\"$HASH_B\",\"suffixHash\":\"$SUF\",\"method\":\"scan\",\"checkedInAt\":\"2026-08-08T10:02:00.000Z\",\"deviceId\":\"devA\"}
  ]}")
check "イベント1件が登録される" "$(echo "$r" | grep -o '"stored":{"events":[0-9]*' | grep -o '[0-9]*$')" "1"
check "チェックイン2件が登録される" "$(echo "$r" | grep -o '"checkins":[0-9]*' | head -1 | grep -o '[0-9]*$')" "2"

echo "3) 同じ内容を再送（冪等性）"
r=$(curl -s --noproxy '*' -X POST "$API" -H "$H" -H 'Content-Type: application/json' -d "{
  \"checkins\":[{\"id\":\"$C1\",\"eventId\":\"$EV\",\"memberHash\":\"$HASH_A\",\"suffixHash\":\"$SUF\",\"method\":\"scan\",\"checkedInAt\":\"2026-08-08T10:01:00.000Z\",\"deviceId\":\"devA\"}]}")
check "再送は登録されない" "$(echo "$r" | grep -o '"checkins":[0-9]*' | head -1 | grep -o '[0-9]*$')" "0"

echo "4) 端末間の重複"
r=$(curl -s --noproxy '*' -X POST "$API" -H "$H" -H 'Content-Type: application/json' -d "{
  \"checkins\":[{\"id\":\"$C3\",\"eventId\":\"$EV\",\"memberHash\":\"$HASH_A\",\"suffixHash\":\"$SUF\",\"method\":\"scan\",\"checkedInAt\":\"2026-08-08T10:03:00.000Z\",\"deviceId\":\"devB\"}]}")
check "別端末が読んだ同一来場者は登録されない" "$(echo "$r" | grep -o '"checkins":[0-9]*' | head -1 | grep -o '[0-9]*$')" "0"
check "無視された件数が1と報告される" "$(echo "$r" | grep -o '"ignored":{"events":[0-9]*,"checkins":[0-9]*' | grep -o '[0-9]*$')" "1"

echo "5) 不正データの排除"
r=$(curl -s --noproxy '*' -X POST "$API" -H "$H" -H 'Content-Type: application/json' -d "{
  \"checkins\":[{\"id\":\"$C4\",\"eventId\":\"$EV\",\"memberHash\":\"328913579881\",\"suffixHash\":\"$SUF\",\"method\":\"scan\",\"checkedInAt\":\"2026-08-08T10:04:00.000Z\",\"deviceId\":\"devB\"}]}")
check "生の12桁IDは破棄される" "$(echo "$r" | grep -o '"rejected":{"events":[0-9]*,"checkins":[0-9]*' | grep -o '[0-9]*$')" "1"

echo "6) 取得"
r=$(curl -s --noproxy '*' "$API?eventId=$EV" -H "$H")
check "このイベントのチェックインは2件" "$(echo "$r" | grep -o "\"id\":\"[0-9a-f-]*\",\"eventId\"" | wc -l | tr -d ' ')" "2"
check "nextSinceが返る" "$(echo "$r" | grep -c 'nextSince')" "1"

echo
echo "結果: PASS $pass / FAIL $fail"
[ "$fail" -eq 0 ]
