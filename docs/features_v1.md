# 本プロジェクトで使う Claude Code 機能一覧 v1.1 + 検証記録

別添（機能一覧 v1.1）の要点と、着手前に行った存在確認（別添 C.4 準拠）の記録。
検証環境: `claude` CLI **v2.1.207**（`claude --version`）。確認方法は `claude --help` の該当行。

## A. v1 で使う機能 — 検証結果

| # | 機能 | 検証 | フラグ/コマンド |
|---|---|---|---|
| 1 | CLAUDE.md / AGENTS.md | ✓ | `AGENTS.md`（本体）+ `CLAUDE.md`（ポインタ） |
| 2 | Skills | ✓ | `.claude/skills/<name>/SKILL.md`、`/skill` で起動 |
| 3 | settings.json permissions | ✓ | `.claude/settings.json`（allow/deny/ask） |
| 4 | Plan Mode | ✓ | `claude --permission-mode plan`（choices に `plan` を確認） |
| 5 | Print Mode + 上限 | 一部 | `-p/--print` ✓ / `--max-budget-usd` ✓（print専用） / **`--max-turns` ✗ 本バージョンに無し** |
| 6 | モデル指定 | ✓ | `--model` / セッション内 `/model` |
| 7 | MCP（Notion） | ✓(コマンド存在) | `claude mcp add`（HTTP は `--transport http`）。**未実行**（後述） |
| 8 | gh CLI 連携 | 前提 | `Bash(gh ...)`。settings.json では `ask` に配置 |
| 9 | セッション運用 | ✓ | `/clear` `/compact` `/cost` |
| 10 | 履歴読み取り | ✓ | `~/.claude/` 配下（profile.md 第1段） |

### C.4 に基づく報告（確認できなかった/代替した点）
- **`--max-turns`**: v2.1.207 の `claude --help` に該当フラグ無し。→ **代替**: `--max-budget-usd`（存在確認済み）で上限管理。`budget_guard.sh` はこの前提で実装し、実行時にも `--max-budget-usd` の存在を再チェックする。公式ドキュメントで復活/別名を要確認: https://code.claude.com/docs
- **Notion MCP 追加（§7）**: `claude mcp add` コマンドは存在するが、**接続 URL / トークンが必要な外部設定であり破壊的・要承認（C.1）**のため未実行。手順は下記。

## Notion MCP 追加手順（承認後に実行）
```bash
# 例（実際の URL / 認証はユーザ提供のものに置換）
claude mcp add --transport http notion https://mcp.notion.com/mcp
# 認証が必要なら --header "Authorization: Bearer <token>" を付与
```
登録後、`/capture` と `/research-import` の `allowed-tools` に列挙した `mcp__Notion__*`（読み取り）が有効になる。書き戻し系ツールは付与しない。

## B. v1 では封印（別添 B）
サブエージェント / GitHub Actions / Hooks / `git push` 自動化 は v1 で使わない。`--dangerously-skip-permissions` は恒久禁止。
