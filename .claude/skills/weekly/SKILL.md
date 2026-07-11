---
name: weekly
description: 直近1週間の inbox/notes/research を集計して週次レビューを 40_reviews/ に生成する。「週次レビュー」「今週まとめて」「weekly やって」と言われたら使う。非対話実行は budget_guard.sh 経由を推奨。
argument-hint: "[対象週の任意ラベル（省略時は直近7日）]"
allowed-tools: Read, Write, Bash(git log:*)
---

# /weekly — 週次レビュー

## 目的
1週間の流れを俯瞰し、進捗・詰まり・次週の焦点を1枚にまとめる。

## 手順
1. 対象期間（既定: 直近7日）の `10_inbox/` `20_notes/` `30_research/` を走査。
   - 補助として `git log --since` で活動量も見てよい。
2. 集計:
   - 捕捉件数 / 判断で残した件数 / 取り込んだリサーチ件数
   - 主要トピック（tags 頻度）
   - 未処理（`status: raw` のまま滞留している inbox）
3. `40_reviews/YYYYMMDD-weekly.md` を作成:
   ```yaml
   type: weekly
   status: processed
   ```
   本文: ①今週の要点 ②滞留・詰まり ③次週の焦点3つ ④要承認の保留事項。
4. 破壊的な整理（大量 archive 等）は案として出し承認を得る（C.1）。

## 完了報告
生成した weekly ファイル名と、次週の焦点3点を要約。exit code つきで verify を回すと尚良い。
