#!/usr/bin/env bash
# budget_guard.sh — 非対話(print mode)実行を予算上限つきで包む
#
# 使い方:
#   scripts/budget_guard.sh "<プロンプト or /skill 引数>" [予算USD] [モデル]
# 例:
#   scripts/budget_guard.sh "/weekly" 0.50 opus
#
# 注意:
# - 本バージョンの claude CLI に --max-turns は無いため、上限は --max-budget-usd で制御する
#   (AGENTS.md §4 / C.4)。存在確認: `claude --help | grep max-budget-usd`
# - --dangerously-skip-permissions は恒久禁止。付与しない。
set -euo pipefail

PROMPT="${1:?プロンプト（または /skill 呼び出し）を第1引数に渡すこと}"
BUDGET_USD="${2:-0.50}"
MODEL="${3:-opus}"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude CLI が見つからない" >&2
  exit 127
fi

# --max-budget-usd の存在をランタイム確認（無ければ停止して報告）
if ! claude --help 2>&1 | grep -q -- "--max-budget-usd"; then
  echo "error: この claude バージョンに --max-budget-usd が無い。代替を検討のこと" >&2
  exit 3
fi

echo "→ claude -p (model=${MODEL}, max-budget-usd=${BUDGET_USD})" >&2
exec claude -p "${PROMPT}" \
  --model "${MODEL}" \
  --max-budget-usd "${BUDGET_USD}"
