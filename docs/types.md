# 型（型 / エントリスキーマ）定義 — v1

外部脳の全 content Markdown が従う YAML frontmatter スキーマ。`scripts/verify_structure.py` がこの定義に対して検証する。

## 共通 frontmatter

```yaml
---
id: 20260711-market-scan      # YYYYMMDD-<slug>。ファイル名と一致
type: note                    # capture | note | judgment | research | weekly
title: 市場スキャン 2026-07    # 見出し（1行）
created: 2026-07-11           # YYYY-MM-DD
source: manual                # notion-inbox | web | manual
status: processed             # raw | processed | archived
tags: [market, competitor]    # 0個以上。空リスト可
---
```

## type と配置先

| type | 配置ディレクトリ | 生成スキル | 代表 status |
|---|---|---|---|
| `capture` | `10_inbox/` | `/capture` | `raw` |
| `note` | `20_notes/` | `/judge` | `processed` |
| `judgment` | `20_notes/` | `/judge` | `processed` |
| `research` | `30_research/` | `/research-import` | `processed` |
| `weekly` | `40_reviews/` | `/weekly` | `processed` |

## 検証ルール（verify_structure.py が強制）

1. `10_`〜`40_`, `90_self/` 配下の `*.md` は frontmatter を持つ。
2. 必須キー（`id` `type` `title` `created` `source` `status` `tags`）が揃う。
3. `type` / `source` / `status` は上記 enum のいずれか。
4. `created` は `YYYY-MM-DD`、`id` は `YYYYMMDD-<slug>` 形式。
5. `type` と実際の配置ディレクトリが上表に一致する。
6. ファイル名（拡張子除く）が `id` と一致する。

> `90_self/profile.md` と各 `README`/テンプレート等は frontmatter 検証の対象外（`_` 始まりや profile は除外）。詳細は verify_structure.py の EXCLUDE を参照。
