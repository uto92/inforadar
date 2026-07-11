---
name: research-import
description: 外部リサーチ（Notion のリサーチ用DB / Web 記事 / レポート）を 30_research/ に構造化して取り込む。「これ取り込んで」「リサーチをインポート」「調査結果を保存」と言われたら使う。取り込みは読み取り中心、書き戻しは承認後のみ。
argument-hint: "[Notion ページ / URL / 貼り付けテキスト（省略時は Notion のリサーチ Inbox を読む）]"
allowed-tools: Read, Write, mcp__Notion__notion-search, mcp__Notion__notion-fetch, mcp__Notion__notion-query-data-sources, WebFetch
---

# /research-import — リサーチ取込

## 目的
外部リサーチを再利用可能な形（要約＋出典＋タグ）で `30_research/` に定着させる。

## 手順
1. 入力を取得。
   - 引数なし → Notion MCP（読み取り）でリサーチ関連ページを検索・取得。
   - URL → WebFetch で本文取得。
2. 1件につき `30_research/YYYYMMDD-<slug>.md` を作成:
   ```yaml
   id: <YYYYMMDD-slug>
   type: research
   title: <原題>
   created: <YYYY-MM-DD>
   source: notion-inbox   # or web
   status: processed
   tags: [<領域>]
   ---
   ```
   本文: 3〜5行要約 / キー数値・引用 / 出典 URL / 示唆。
3. 元情報の**書き戻しはしない**。Notion へ更新が要る場合は案を提示し承認を得る（C.1）。
4. 秘密情報・購読者限定本文の全文転載は避け、要約と出典に留める。

## 完了報告
取り込んだ research ファイル一覧、件数、source を明記。
