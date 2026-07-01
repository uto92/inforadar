#!/usr/bin/env python3
"""InfoRadar: 公開情報モニタリング（RSS 差分検知 → Markdown レポート → Gmail 通知）.

使い方:
    python inforadar.py                 # ドライラン（レポート生成のみ）
    python inforadar.py --notify        # Gmail 通知あり（環境変数が必要）
    python inforadar.py --feeds x.yaml  # フィード定義を差し替え（テスト用）

状態は state.json に永続化する（既読エントリID）。初回取得のフィードは
ベースライン登録し、直近 FIRST_RUN_SHOW 件のみレポートに載せる。
"""

import argparse
import hashlib
import json
import os
import smtplib
import sys
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
from email.header import Header
from pathlib import Path

import feedparser
import requests
import yaml

JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).parent
STATE_PATH = ROOT / "state.json"
REPORT_DIR = ROOT / "reports"

FETCH_TIMEOUT = 20
USER_AGENT = "InfoRadar/0.1 (+https://github.com/uto92/inforadar)"
MAX_SEEN_PER_FEED = 500   # フィードごとの既読ID保持上限
FIRST_RUN_SHOW = 5        # 初回取得時にレポートへ載せる件数


def load_yaml(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_state() -> dict:
    if STATE_PATH.exists():
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {"feeds": {}}


def save_state(state: dict) -> None:
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")


def entry_id(entry) -> str:
    """エントリの安定ID。id → link → title+published の順でフォールバック。"""
    raw = entry.get("id") or entry.get("link") or (
        entry.get("title", "") + entry.get("published", "")
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def fetch_feed(url: str):
    """URL または ローカルパスからフィードを取得してパースする。"""
    if os.path.exists(url):  # テスト用フィクスチャ
        return feedparser.parse(url)
    resp = requests.get(url, timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return feedparser.parse(resp.content)


def match_keywords(entry, keywords) -> list:
    """タイトル・概要にマッチしたキーワードを返す。"""
    text = entry.get("title", "") + " " + entry.get("summary", "")
    return [kw for kw in keywords if kw in text]


def check_feed(feed_cfg: dict, state: dict, global_keywords: list) -> dict:
    """1フィードを取得し、新着エントリと状態更新を返す。"""
    url = feed_cfg["url"]
    keywords = list(feed_cfg.get("keywords", [])) + list(global_keywords)
    feed_state = state["feeds"].setdefault(url, {"seen": []})
    first_run = not feed_state["seen"]
    seen = set(feed_state["seen"])

    parsed = fetch_feed(url)
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"パース失敗: {parsed.bozo_exception}")

    new_entries = []
    for entry in parsed.entries:
        eid = entry_id(entry)
        if eid in seen:
            continue
        seen.add(eid)
        new_entries.append({
            "title": entry.get("title", "(no title)").strip(),
            "link": entry.get("link", ""),
            "published": entry.get("published", entry.get("updated", "")),
            "matched": match_keywords(entry, keywords),
        })

    # 既読IDは新しいものを先頭に保持し、上限で切り詰める
    feed_state["seen"] = (
        [entry_id(e) for e in parsed.entries] +
        [i for i in feed_state["seen"] if i in seen]
    )[:MAX_SEEN_PER_FEED]
    feed_state["last_checked"] = datetime.now(JST).isoformat(timespec="seconds")

    shown = new_entries[:FIRST_RUN_SHOW] if first_run else new_entries
    return {
        "name": feed_cfg["name"],
        "first_run": first_run,
        "new_count": len(new_entries),
        "entries": shown,
    }


def build_report(results_by_category: dict, errors: list, now: datetime) -> str:
    """カテゴリ別の Markdown レポートを組み立てる。"""
    lines = [f"# InfoRadar レポート {now.strftime('%Y-%m-%d %H:%M')} (JST)", ""]
    total_new = sum(
        r["new_count"] for results in results_by_category.values() for r in results
    )
    lines += [f"新着 **{total_new}** 件／取得失敗 **{len(errors)}** 件", ""]

    for category, results in results_by_category.items():
        section = []
        for r in results:
            if not r["entries"]:
                continue
            note = f"（初回取得・直近{len(r['entries'])}件のみ表示、全{r['new_count']}件をベースライン登録）" if r["first_run"] else f"（新着{r['new_count']}件）"
            section.append(f"### {r['name']} {note}")
            # キーワードマッチを先頭に
            for e in sorted(r["entries"], key=lambda e: not e["matched"]):
                star = "★ " if e["matched"] else ""
                kw = f" `{'/'.join(e['matched'])}`" if e["matched"] else ""
                date = f" — {e['published']}" if e["published"] else ""
                section.append(f"- {star}[{e['title']}]({e['link']}){kw}{date}")
            section.append("")
        if section:
            lines += [f"## {category}", ""] + section

    if errors:
        lines += ["## ⚠️ 取得失敗", ""]
        lines += [f"- **{name}** (`{url}`): {err}" for name, url, err in errors]
        lines.append("")

    if total_new == 0 and not errors:
        lines += ["新着はありません。", ""]
    return "\n".join(lines)


def send_gmail(subject: str, body: str) -> None:
    """Gmail SMTP（アプリパスワード）でレポートを送信する。"""
    address = os.environ["GMAIL_ADDRESS"]
    password = os.environ["GMAIL_APP_PASSWORD"]
    to = os.environ.get("MAIL_TO", address)

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = address
    msg["To"] = to
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(address, password)
        smtp.send_message(msg)


def main() -> int:
    parser = argparse.ArgumentParser(description="InfoRadar: RSS差分検知＋通知")
    parser.add_argument("--feeds", default=str(ROOT / "feeds.yaml"))
    parser.add_argument("--notify", action="store_true",
                        help="新着があれば Gmail 通知する（GMAIL_ADDRESS / GMAIL_APP_PASSWORD が必要）")
    args = parser.parse_args()

    config = load_yaml(Path(args.feeds))
    state = load_state()
    global_keywords = config.get("global_keywords", [])
    now = datetime.now(JST)

    results_by_category = {}
    errors = []
    for category in config.get("categories", []):
        results = []
        for feed_cfg in category.get("feeds", []):
            if not feed_cfg.get("enabled", True):
                continue
            try:
                results.append(check_feed(feed_cfg, state, global_keywords))
            except Exception as e:  # 1フィードの失敗で全体を止めない
                errors.append((feed_cfg["name"], feed_cfg["url"], str(e)))
        results_by_category[category["name"]] = results

    report = build_report(results_by_category, errors, now)
    REPORT_DIR.mkdir(exist_ok=True)
    report_path = REPORT_DIR / f"{now.strftime('%Y-%m-%d')}.md"
    report_path.write_text(report, encoding="utf-8")
    save_state(state)
    print(report)
    print(f"\n[info] レポート: {report_path}", file=sys.stderr)

    total_new = sum(
        r["new_count"] for rs in results_by_category.values() for r in rs
    )
    if args.notify:
        if not (os.environ.get("GMAIL_ADDRESS") and os.environ.get("GMAIL_APP_PASSWORD")):
            print("[warn] GMAIL_ADDRESS / GMAIL_APP_PASSWORD 未設定のため通知をスキップ",
                  file=sys.stderr)
        elif total_new == 0 and not errors:
            print("[info] 新着なしのため通知をスキップ", file=sys.stderr)
        else:
            send_gmail(f"InfoRadar {now.strftime('%m/%d')}: 新着{total_new}件", report)
            print("[info] Gmail 通知を送信しました", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
