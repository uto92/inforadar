# external_brain_handoff_v1.md — 指示書（v1）

> **重要 / DRAFT 再構成**: オリジナルの指示書は本リポジトリに存在せず提供もされなかった。
> 本ファイルは **別添「機能一覧 v1.1」から逆算して再構成した骨子**であり、各章の
> 本文は暫定。オリジナルを入手したら差し替えること。推測で埋めた箇所は「（推定）」と明記した。

関連: 別添は `docs/features_v1.md`。運用原則の本体は `AGENTS.md`。型は `docs/types.md`。

---

## 1. 全体像 / Notion 連携（推定）
外部脳は Notion Inbox を入口に、捕捉→判断→ノート→レビューのループで情報を資産化する。
Notion MCP は読み取り中心（`/capture` `/research-import` が使用）。書き戻しは承認後のみ。

## 2. 作業原則 / 型の位置づけ（推定）
- 絶対原則は別添 C 章＝ `AGENTS.md §1` に集約。
- 「型」＝エントリの frontmatter スキーマ（`docs/types.md`）。10章で移植対象として再掲。

## 3. 5スキルの定義
`/capture` `/judge` `/review3` `/weekly` `/research-import`。
実体は `.claude/skills/<name>/SKILL.md`。frontmatter は `name`/`description`/`argument-hint`/`allowed-tools`。
（各スキルの詳細手順は SKILL.md 側に実装済み。§3.1=capture, §3.5=research-import が Notion 読み取りを行う。）

## 4. 権限・実行
- 4.1 権限: 最小権限。`git push`/`rm` は deny、secrets は Read 拒否 → `.claude/settings.json`。
- 4.3 非対話: `scripts/budget_guard.sh`（`claude -p --max-budget-usd`）。**`--max-turns` は本バージョンに無い**ため予算上限で制御（検証記録: `docs/features_v1.md`）。

## 5. （推定）運用フロー / セッション衛生
`/clear` `/compact` `/cost` を用いたセッション衛生（別添 A-9）。

## 6. self / profile.md
`90_self/profile.md` 第1段はセッション履歴分析で反復パターンを証拠付き抽出。秘密情報は転記しない。

## 7. 導入ステップ
- Step 0（推定）: **Plan Mode（`claude --permission-mode plan`）で既存 Business OS を棚卸し**（読むだけ）。統合・削除案を承認後に通常モードへ。※本リポジトリは既存資産なし＝グリーンフィールドのため骨格を新規作成した（設計判断）。
- Step 1（推定）: リポジトリ作成 / 将来の Issue 運用（`gh` CLI）。

## 8. gh CLI 連携（推定）
リポジトリ作成・Issue 運用に `Bash(gh *)`。許可はスキルごとに絞る（settings.json では `ask` に設定）。

## 9. モデルルーティング（v2 予定）
v1 は Opus。分類系（`/capture` 仕分け等）を Haiku/Sonnet に落とすのは v2。

## 10. 型の移植 / 委任条件（推定）
型定義を `docs/types.md` に移植済み。サブエージェント委任は別添 B の4条件を満たす場合のみ（v2）。

---

### 未確定 / 要オリジナル参照
- 各章の詳細本文（特に 1, 5, 7, 8, 10 の具体手順）
- 「既存 Business OS」の実体（棚卸し対象）— 現状リポジトリには存在しない
- 委任の4条件の正確な内容（10章）
