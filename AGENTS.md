# AGENTS.md — inforadar 外部脳 / Business OS（本体メモリ）

> このファイルが**運用原則の本体**（ベンダー中立）。`CLAUDE.md` はここへのポインタのみ。
> あらゆる作業（対話・スキル・非対話実行）の前に、常にこの内容が読み込まれている前提で動くこと。

---

## 0. このリポジトリは何か

`inforadar` は個人／事業の「外部脳（Business OS）」。断片情報を **捕捉 → 判断 → ノート化 → 定期レビュー** の一本のループで資産に変える。
運用は Claude Code の 5 スキル（`/capture` `/judge` `/review3` `/weekly` `/research-import`）で回す。

---

## 1. 絶対原則（最重要・C章準拠）

1. **破壊的操作は「案の提示 → 人間承認 → 実行」**。対象＝移動・削除・`git push`・Issue 作成・外部への書き戻し（Notion 等）。承認なしに実行しない。
2. **完了報告には検証の証拠を必ず添える**。テスト名 / exit code / 差分のいずれか。「動いた」だけの報告は無効。
3. **失敗は最大 5 回まで自力修正**。解決しなければ状況を報告して停止する。
4. **確認できない機能・フラグは使わない**。`claude --help` と公式ドキュメント（code.claude.com/docs）で存在確認できないものは使わず、該当 URL とともに代替案を報告する。
5. **`--dangerously-skip-permissions` は恒久禁止**。いかなる場合も使わない。

---

## 2. リポジトリ規約

### 2.1 ディレクトリ構造

```
10_inbox/      捕捉直後の生データ（status: raw）。/capture の着地点
20_notes/      判断・整形済みノート（status: processed）
30_research/   /research-import で取り込んだ外部リサーチ
40_reviews/    /weekly の週次レビュー、/review3 の3観点レビュー
90_self/       自己プロファイル。profile.md はログ分析(第1段)の成果物
docs/          指示書・型定義などシステム文書
scripts/       budget_guard.sh / verify_structure.py
.claude/       settings.json（権限）と skills/（5スキル）
```

### 2.2 型（エントリの frontmatter スキーマ）

全ての content Markdown（`10_`〜`40_`、`90_self/`）は先頭に YAML frontmatter を持つ。
詳細と例は `docs/types.md`。必須キー:

| キー | 型 | 説明 |
|---|---|---|
| `id` | string | `YYYYMMDD-<slug>` 形式の一意 ID |
| `type` | enum | `capture` \| `note` \| `judgment` \| `research` \| `weekly` |
| `title` | string | 見出し |
| `created` | date | `YYYY-MM-DD` |
| `source` | enum | `notion-inbox` \| `web` \| `manual` |
| `status` | enum | `raw` \| `processed` \| `archived` |
| `tags` | list | 任意個。空可 |

`type` と配置先の対応: `capture`→`10_inbox/`、`note`/`judgment`→`20_notes/`、`research`→`30_research/`、`weekly`→`40_reviews/`。

### 2.3 命名

- ファイル名は `id` と一致させる（例 `20260711-market-scan.md`）。
- 秘密情報（API キー・トークン・個人情報）は content に書かない。`profile.md` へのログ転記時も同様（C章・§10注意）。

---

## 3. スキル運用の要点

| スキル | 役割 | 主な入力 → 出力 |
|---|---|---|
| `/capture` | Notion Inbox / 手元断片を捕捉 | Notion(読) → `10_inbox/*.md` |
| `/judge` | 捕捉物を判断し残す/捨てる | `10_inbox/` → `20_notes/`（judgment） |
| `/review3` | 3観点（事実/示唆/反証）でノート点検 | `20_notes/` → `40_reviews/` |
| `/weekly` | 週次レビュー生成 | 全体 → `40_reviews/weekly-*.md` |
| `/research-import` | 外部リサーチ取込 | Notion/web(読) → `30_research/*.md` |

各スキルの詳細は `.claude/skills/<name>/SKILL.md`。frontmatter に `name` / `description` / `argument-hint` / `allowed-tools` を必ず持つ。

---

## 4. 権限とモデル

- 権限は `.claude/settings.json` で最小権限を強制。`git push` と `rm` は **deny**、secrets 系は Read 拒否。
- v1 実装モデルは Opus。分類系（`/capture` の仕分け等）を Haiku/Sonnet に落とすのは v2。
- 非対話実行は必ず `scripts/budget_guard.sh` 経由（`claude -p --max-budget-usd ...`）。本バージョンに `--max-turns` は無いため予算上限で制御する。

---

## 5. セッション衛生

- 無関係タスク間で `/clear`（文脈汚染防止）。長時間セッションは `/compact`。コストは `/cost` で随時確認。

---

## 6. v1 で封印する機能（明示）

サブエージェント / GitHub Actions / Hooks / `git push` 自動化 は v1 では使わない（v2 で条件付き解禁）。`--dangerously-skip-permissions` は恒久禁止。

---

## 7. 検証

構造の健全性は `python3 scripts/verify_structure.py` で確認する。完了報告時はこの exit code / 出力を証拠として添える（§1-2）。
