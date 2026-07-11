#!/usr/bin/env python3
"""verify_structure.py — inforadar 外部脳の構造検証（v1）

依存なし（標準ライブラリのみ）。frontmatter は簡易パーサで解釈する。
AGENTS.md §7 / docs/types.md の検証ルールを強制する。

exit code: 0 = 健全 / 1 = 違反あり
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 必須トップレベル構造
REQUIRED_DIRS = ["10_inbox", "20_notes", "30_research", "40_reviews", "90_self",
                 "docs", "scripts", ".claude/skills"]
REQUIRED_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/settings.json",
                  "docs/types.md", "90_self/profile.md"]
REQUIRED_SKILLS = ["capture", "judge", "review3", "weekly", "research-import"]

# frontmatter 検証対象ディレクトリ
CONTENT_DIRS = ["10_inbox", "20_notes", "30_research", "40_reviews"]

TYPE_DIR = {
    "capture": "10_inbox",
    "note": "20_notes",
    "judgment": "20_notes",
    "research": "30_research",
    "weekly": "40_reviews",
}
ENUM = {
    "type": set(TYPE_DIR),
    "source": {"notion-inbox", "web", "manual"},
    "status": {"raw", "processed", "archived"},
}
REQUIRED_KEYS = ["id", "type", "title", "created", "source", "status", "tags"]

# 検証除外: テンプレート/README/ドット始まり
EXCLUDE_NAME = re.compile(r"^(_|\.).*|.*README.*", re.IGNORECASE)

ID_RE = re.compile(r"^\d{8}-[a-z0-9][a-z0-9-]*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_frontmatter(text: str):
    """先頭 --- ... --- を dict にする簡易パーサ。tags は [] / インライン対応。"""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    block = text[3:end].strip("\n")
    data = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            val = [v.strip() for v in inner.split(",") if v.strip()] if inner else []
        data[key] = val
    return data


def main() -> int:
    errors: list[str] = []

    for d in REQUIRED_DIRS:
        if not (ROOT / d).is_dir():
            errors.append(f"[dir] 必須ディレクトリが無い: {d}/")
    for f in REQUIRED_FILES:
        if not (ROOT / f).is_file():
            errors.append(f"[file] 必須ファイルが無い: {f}")
    for s in REQUIRED_SKILLS:
        if not (ROOT / ".claude/skills" / s / "SKILL.md").is_file():
            errors.append(f"[skill] SKILL.md が無い: .claude/skills/{s}/SKILL.md")

    # settings.json の deny 検証
    settings = ROOT / ".claude/settings.json"
    if settings.is_file():
        raw = settings.read_text(encoding="utf-8")
        for needed in ["git push", "rm"]:
            if needed not in raw:
                errors.append(f"[settings] deny に '{needed}' が見当たらない")

    # content frontmatter 検証
    for cdir in CONTENT_DIRS:
        base = ROOT / cdir
        if not base.is_dir():
            continue
        for md in sorted(base.rglob("*.md")):
            if EXCLUDE_NAME.match(md.name):
                continue
            rel = md.relative_to(ROOT)
            fm = parse_frontmatter(md.read_text(encoding="utf-8"))
            if fm is None:
                errors.append(f"[fm] frontmatter が無い: {rel}")
                continue
            for k in REQUIRED_KEYS:
                if k not in fm:
                    errors.append(f"[fm] 必須キー '{k}' が無い: {rel}")
            for k, allowed in ENUM.items():
                if k in fm and fm[k] not in allowed:
                    errors.append(f"[fm] {k}='{fm[k]}' は不正（許可: {sorted(allowed)}): {rel}")
            if "id" in fm and not ID_RE.match(str(fm["id"])):
                errors.append(f"[fm] id 形式不正 'YYYYMMDD-slug': {rel}")
            if "created" in fm and not DATE_RE.match(str(fm["created"])):
                errors.append(f"[fm] created 形式不正 'YYYY-MM-DD': {rel}")
            if "id" in fm and md.stem != str(fm["id"]):
                errors.append(f"[fm] ファイル名が id と不一致 (id={fm['id']}): {rel}")
            if fm.get("type") in TYPE_DIR and TYPE_DIR[fm["type"]] != cdir:
                errors.append(
                    f"[fm] type='{fm['type']}' は {TYPE_DIR[fm['type']]}/ に置くべき: {rel}")

    if errors:
        print(f"✗ 構造検証: {len(errors)} 件の違反")
        for e in errors:
            print("  - " + e)
        return 1
    print("✓ 構造検証: 違反なし")
    return 0


if __name__ == "__main__":
    sys.exit(main())
