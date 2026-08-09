#!/usr/bin/env bash
# ローカルの wrangler dev に対して、mock HEX の投入から再解析までを一通り叩く。
#
#   端末A: npm run migrate:local && npm run seed:local && npm run dev
#   端末B: TOKEN=devtoken123 ./tools/e2e-local.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
TOKEN="${TOKEN:?TOKEN が未設定です（.dev.vars の API_TOKEN と同じ値）}"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")
CARD_OLD="mockcard-a-00000000000000000000000000000000"
CARD_NEW="mockcard-a2-0000000000000000000000000000000"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "疎通確認"
curl -sS "${BASE}/v1/health"; echo

say "mock HEX を投入（20ブロック = 履歴12件 + 空き枠）"
node tools/mock-hex.mjs --card="${CARD_OLD}" --participant=P001 \
  --start-date=2026-06-01 --start-seq=2000 --records=12 > /tmp/mock-session.json
curl -sS -X POST "${BASE}/v1/ingest" "${AUTH[@]}" -d @/tmp/mock-session.json; echo

say "同じ本文をもう一度送る（再送は二重保存されない）"
curl -sS -X POST "${BASE}/v1/ingest" "${AUTH[@]}" -d @/tmp/mock-session.json; echo

say "機種変更で仮名が変わった状況（同じ実カードの履歴が別仮名で届く）"
node tools/mock-hex.mjs --card="${CARD_NEW}" --participant=P001 --device=new-iphone \
  --start-date=2026-06-01 --start-seq=2000 --records=6 \
  | curl -sS -X POST "${BASE}/v1/ingest" "${AUTH[@]}" -d @-; echo

say "カード仮名単位（畳まない）"
curl -sS "${BASE}/v1/transactions?card_pseudonym=${CARD_OLD}" "${AUTH[@]}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print("rows:", len(data["transactions"]))
for t in data["transactions"][:5]:
    print("  %s %-6s %-12s -> %-12s 残額=%-6s 利用額(推定)=%s" % (
        t["used_date"], t["proc_type_label"], t["entry_label"],
        t["exit_label"], t["balance"], t["amount_estimated"]))
'

say "被験者単位（別仮名の同一取引を統合）"
curl -sS "${BASE}/v1/transactions?participant_id=P001" "${AUTH[@]}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("rows:", len(d["transactions"]), "deduped:", d["deduped"])'

say "解釈状況"
curl -sS "${BASE}/v1/parser" "${AUTH[@]}"; echo

say "全期間の再解析（derived を全消し→生HEXから再生成）"
curl -sS -X POST "${BASE}/v1/reparse" "${AUTH[@]}"; echo

say "再解析後も生データは減らない"
curl -sS "${BASE}/v1/parser" "${AUTH[@]}"; echo
