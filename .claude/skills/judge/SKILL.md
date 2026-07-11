---
name: judge
description: 10_inbox/ の捕捉物を1件ずつ判断し「残す/捨てる/保留」を決めて 20_notes/ にノート化する。「仕分けて」「判断して」「Inbox を片付けて」と言われたら使う。捨てる=削除は破壊的操作なので必ず承認を取る。
argument-hint: "[対象の inbox ファイル名（省略時は 10_inbox/ 全件を対象）]"
allowed-tools: Read, Write, Edit
---

# /judge — 判断

## 目的
捕捉物を判断し、価値あるものを `20_notes/`（`type: note` または `judgment`）へ昇格させる。

## 手順
1. 対象 Inbox を読む（引数指定 or `10_inbox/` 全件）。
2. 各件を3判定: **残す / 捨てる / 保留**。判断根拠を1〜2行で記す。
3. 「残す」→ `20_notes/YYYYMMDD-<slug>.md` を作成。
   ```yaml
   type: judgment   # 判断そのものを残すなら judgment、素材ノートなら note
   status: processed
   ```
   本文: 要約・示唆・次アクション・出典リンク（元 inbox の id）。
4. 「捨てる/保留」→ **削除は行わず案として提示**し、人間の承認後にのみ status 変更や移動（C.1）。承認なしに `rm` しない（settings.json でも deny）。
5. 昇格元 inbox は `status: archived` に更新（削除ではなく退避）。

## 完了報告
判定サマリ（残す/捨てる/保留の件数）と、生成した notes 一覧、承認待ち項目を明示。
