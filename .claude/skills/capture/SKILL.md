---
name: capture
description: Notion Inbox や手元の断片情報を外部脳へ捕捉する。情報を「あとで見る」「メモっといて」「Inbox 取り込んで」と言われたら必ず使う。まだ判断はせず 10_inbox/ に生データとして着地させるだけ。
argument-hint: "[Notion Inbox / URL / 貼り付けテキスト（省略時は Notion Inbox を読む）]"
allowed-tools: Read, Write, mcp__Notion__notion-search, mcp__Notion__notion-fetch, mcp__Notion__notion-query-data-sources
---

# /capture — 捕捉

## 目的
断片情報を **判断せずに** `10_inbox/` へ着地させる。仕分けは `/judge` の仕事。

## 手順
1. 入力を取得する。
   - 引数が空 → Notion MCP（読み取り）で Inbox を検索・取得。
   - 引数が URL/テキスト → それを対象にする。
2. 1件につき `10_inbox/YYYYMMDD-<slug>.md` を作る。frontmatter（`docs/types.md` 準拠）:
   ```yaml
   ---
   id: <YYYYMMDD-slug>
   type: capture
   title: <元の見出し>
   created: <YYYY-MM-DD>
   source: notion-inbox   # or web / manual
   status: raw
   tags: []
   ---
   ```
   本文に元テキスト＋出典（Notion ページ URL 等）を残す。
3. **秘密情報（トークン等）は本文に書かない**（AGENTS.md §2.3）。
4. Notion への書き戻しはしない（読み取りのみ）。書き戻しが要るなら案を出して承認を得る（C.1）。

## 完了報告
作成した Inbox ファイル名一覧を出す。件数と source を明記。
