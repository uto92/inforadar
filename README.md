# inforadar

個人／事業の **外部脳（Business OS）**。断片情報を「捕捉 → 判断 → ノート化 → 定期レビュー」の
一本のループで資産化する。運用は Claude Code の 5 スキルで回す。

## クイックスタート
- 運用原則の本体: **[`AGENTS.md`](AGENTS.md)**（`CLAUDE.md` はポインタ）
- 型（frontmatter スキーマ): [`docs/types.md`](docs/types.md)
- 指示書(ドラフト再構成): [`docs/external_brain_handoff_v1.md`](docs/external_brain_handoff_v1.md)
- 機能一覧 + 検証記録: [`docs/features_v1.md`](docs/features_v1.md)

## スキル
| コマンド | 役割 |
|---|---|
| `/capture` | Notion Inbox / 断片を `10_inbox/` に捕捉 |
| `/judge` | 捕捉物を判断し `20_notes/` に昇格 |
| `/review3` | 事実/示唆/反証の3観点で点検 |
| `/weekly` | 週次レビューを `40_reviews/` に生成 |
| `/research-import` | 外部リサーチを `30_research/` に取込 |

## 構造検証
```bash
python3 scripts/verify_structure.py   # exit 0 = 健全
```

## 非対話実行（予算上限つき）
```bash
scripts/budget_guard.sh "/weekly" 0.50 opus
```

## 原則（要点）
破壊的操作は 案→承認→実行 / 完了報告に検証の証拠 / 失敗は最大5回で停止・報告 /
確認できない機能は使わず代替報告 / `--dangerously-skip-permissions` 恒久禁止。