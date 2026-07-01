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
import re
import smtplib
import sys
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
from email.header import Header
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

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
MAX_HTML_ITEMS = 100      # HTML監視で1ページから拾うリンク上限


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


def fetch_raw(url: str) -> bytes:
    """URL または ローカルパス（テスト用フィクスチャ）から生データを取得する。"""
    if os.path.exists(url):
        return Path(url).read_bytes()
    resp = requests.get(url, timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.content


def fetch_rss_entries(url: str) -> list:
    """RSS/Atom フィードを取得し、正規化したエントリのリストを返す。"""
    parsed = feedparser.parse(fetch_raw(url))
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"パース失敗: {parsed.bozo_exception}")
    return [{
        "id": entry_id(e),
        "title": e.get("title", "(no title)").strip(),
        "link": e.get("link", ""),
        "published": e.get("published", e.get("updated", "")),
        "text": e.get("title", "") + " " + e.get("summary", ""),
    } for e in parsed.entries]


class LinkCollector(HTMLParser):
    """ページ内の <a href> とアンカーテキストを収集する。"""

    def __init__(self):
        super().__init__()
        self.links = []          # (href, text)
        self._href = None
        self._text = []
        self._depth = 0          # <a> の入れ子タグ深度

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self._href = href
                self._text = []
                self._depth = 0
        elif self._href is not None:
            self._depth += 1

    def handle_endtag(self, tag):
        if self._href is None:
            return
        if tag == "a" or self._depth == 0:
            text = " ".join("".join(self._text).split())
            self.links.append((self._href, text))
            self._href = None
        else:
            self._depth -= 1

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)


def fetch_html_entries(url: str, link_pattern: str) -> list:
    """HTML ページから link_pattern（正規表現）に合うリンクを新着候補として抽出する。

    RSS 非提供サイト向け。リンクURLの出現＝新着とみなす（本文差分は見ない）。
    """
    html = fetch_raw(url).decode("utf-8", errors="replace")
    collector = LinkCollector()
    collector.feed(html)

    pattern = re.compile(link_pattern)
    entries, seen_links = [], set()
    for href, text in collector.links:
        absolute = urljoin(url, href)
        if not pattern.search(absolute) or absolute in seen_links:
            continue
        seen_links.add(absolute)
        entries.append({
            "id": hashlib.sha256(absolute.encode("utf-8")).hexdigest()[:16],
            "title": text or absolute,
            "link": absolute,
            "published": "",
            "text": text,
        })
        if len(entries) >= MAX_HTML_ITEMS:
            break
    if not entries:
        raise ValueError(f"link_pattern '{link_pattern}' に合致するリンクが0件"
                         "（ページ構造の変化かパターン誤りの可能性）")
    return entries


def check_feed(feed_cfg: dict, state: dict, global_keywords: list) -> dict:
    """1ソースを取得し、新着エントリと状態更新を返す。"""
    url = feed_cfg["url"]
    keywords = list(feed_cfg.get("keywords", [])) + list(global_keywords)
    feed_state = state["feeds"].setdefault(url, {"seen": []})
    first_run = not feed_state["seen"]
    seen = set(feed_state["seen"])

    if feed_cfg.get("type", "rss") == "html":
        entries = fetch_html_entries(url, feed_cfg["link_pattern"])
    else:
        entries = fetch_rss_entries(url)

    new_entries = []
    for entry in entries:
        if entry["id"] in seen:
            continue
        seen.add(entry["id"])
        new_entries.append({
            "title": entry["title"],
            "link": entry["link"],
            "published": entry["published"],
            "matched": [kw for kw in keywords if kw in entry["text"]],
        })

    # 既読IDは新しいものを先頭に保持し、上限で切り詰める
    feed_state["seen"] = (
        [e["id"] for e in entries] +
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
