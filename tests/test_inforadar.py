"""InfoRadar コアロジックのテスト（外部通信なし・ローカルフィクスチャで完結）."""

from datetime import datetime, timezone, timedelta

import pytest

import inforadar as ir


JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 7, 2, 7, 30, tzinfo=JST)


# ---------- フィクスチャ生成ヘルパ ----------

RSS_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title><link>https://ex.com/</link>
{items}
</channel></rss>"""

RSS_ITEM = """<item><title>{title}</title><link>{link}</link>
<guid>{link}</guid><description>{desc}</description></item>"""


def write_rss(tmp_path, items):
    body = "\n".join(
        RSS_ITEM.format(title=t, link=l, desc=d) for t, l, d in items
    )
    p = tmp_path / "feed.xml"
    p.write_text(RSS_TEMPLATE.format(items=body), encoding="utf-8")
    return str(p)


def write_html(tmp_path, html):
    p = tmp_path / "page.html"
    p.write_text(html, encoding="utf-8")
    return str(p)


# ---------- entry_id ----------

def test_entry_id_prefers_id_then_link():
    assert ir.entry_id({"id": "A", "link": "B"}) == ir.entry_id({"id": "A"})
    assert ir.entry_id({"link": "B"}) == ir.entry_id({"link": "B", "title": "x"})


def test_entry_id_distinct_for_distinct_input():
    assert ir.entry_id({"id": "A"}) != ir.entry_id({"id": "B"})


def test_entry_id_stable_length():
    assert len(ir.entry_id({"id": "anything"})) == 16


# ---------- LinkCollector ----------

def test_link_collector_extracts_href_and_text():
    c = ir.LinkCollector()
    c.feed('<a href="/x">Hello</a>')
    assert c.links == [("/x", "Hello")]


def test_link_collector_handles_nested_tags_inside_anchor():
    c = ir.LinkCollector()
    c.feed('<a href="/x"><span>2026.07.01</span> タイトル</a>')
    assert c.links == [("/x", "2026.07.01 タイトル")]


def test_link_collector_ignores_anchors_without_href():
    c = ir.LinkCollector()
    c.feed('<a name="top">アンカー</a><a href="/y">Y</a>')
    assert c.links == [("/y", "Y")]


# ---------- fetch_html_entries ----------

HTML_PAGE = """<html><body>
<nav><a href="/">home</a></nav>
<a href="/press/article/2026/07/a.html"><span>07.01</span> WESTER記事</a>
<a href="/press/article/2026/06/b.html">定期券の記事</a>
<a href="https://ex.com/press/article/2026/06/c.html">絶対URL記事</a>
<a href="/press/article/2026/07/a.html">重複リンク</a>
<footer><a href="/sitemap/">map</a></footer>
</body></html>"""


def test_fetch_html_filters_by_pattern_and_resolves_relative(tmp_path):
    url = write_html(tmp_path, HTML_PAGE)
    # base_url に本番相当のURLを与え、相対リンクの絶対化を検証する
    entries = ir.fetch_html_entries(url, "/press/article/",
                                    base_url="https://www.westjr.co.jp/press/")
    links = [e["link"] for e in entries]
    # nav/footer は除外、相対URLは絶対化、重複は排除 → 3件
    assert len(entries) == 3
    assert links[0] == "https://www.westjr.co.jp/press/article/2026/07/a.html"
    assert "https://ex.com/press/article/2026/06/c.html" in links


def test_fetch_html_dedups_same_link(tmp_path):
    url = write_html(tmp_path, HTML_PAGE)
    entries = ir.fetch_html_entries(url, "/press/article/")
    assert len(set(e["link"] for e in entries)) == len(entries)


def test_fetch_html_zero_match_raises(tmp_path):
    url = write_html(tmp_path, HTML_PAGE)
    with pytest.raises(ValueError, match="0件"):
        ir.fetch_html_entries(url, "/no/such/path/")


# ---------- fetch_rss_entries ----------

def test_fetch_rss_normalizes_fields(tmp_path):
    url = write_rss(tmp_path, [("記事A", "https://ex.com/1", "定期券の話")])
    entries = ir.fetch_rss_entries(url)
    assert len(entries) == 1
    e = entries[0]
    assert e["title"] == "記事A"
    assert e["link"] == "https://ex.com/1"
    assert "定期券" in e["text"]


def test_fetch_rss_invalid_raises(tmp_path):
    p = tmp_path / "bad.xml"
    p.write_text("これはXMLではありません" * 3, encoding="utf-8")
    with pytest.raises(ValueError):
        ir.fetch_rss_entries(str(p))


# ---------- check_feed（差分検知の中核） ----------

def fresh_state():
    return {"feeds": {}}


def test_check_feed_first_run_baselines_all(tmp_path):
    url = write_rss(tmp_path, [(f"記事{i}", f"https://ex.com/{i}", "") for i in range(8)])
    state = fresh_state()
    r = ir.check_feed({"name": "t", "url": url}, state, [])
    assert r["first_run"] is True
    assert r["new_count"] == 8
    # 表示は FIRST_RUN_SHOW 件に制限
    assert len(r["entries"]) == ir.FIRST_RUN_SHOW
    # 全8件が seen に登録される
    assert len(state["feeds"][url]["seen"]) == 8


def test_check_feed_second_run_no_diff(tmp_path):
    url = write_rss(tmp_path, [("A", "https://ex.com/1", "")])
    state = fresh_state()
    ir.check_feed({"name": "t", "url": url}, state, [])
    r2 = ir.check_feed({"name": "t", "url": url}, state, [])
    assert r2["first_run"] is False
    assert r2["new_count"] == 0
    assert r2["entries"] == []


def test_check_feed_detects_new_entry(tmp_path):
    items = [("A", "https://ex.com/1", "")]
    url = write_rss(tmp_path, items)
    state = fresh_state()
    ir.check_feed({"name": "t", "url": url}, state, [])
    # 記事を1件追加
    write_rss(tmp_path, [("B", "https://ex.com/2", "")] + items)
    r = ir.check_feed({"name": "t", "url": url}, state, [])
    assert r["new_count"] == 1
    assert r["entries"][0]["title"] == "B"


def test_check_feed_keyword_matching(tmp_path):
    url = write_rss(tmp_path, [("定期券のお知らせ", "https://ex.com/1", "")])
    state = fresh_state()
    r = ir.check_feed({"name": "t", "url": url, "keywords": ["定期券"]}, state, [])
    assert r["entries"][0]["matched"] == ["定期券"]


def test_check_feed_global_keywords_apply(tmp_path):
    url = write_rss(tmp_path, [("MaaS 特集", "https://ex.com/1", "")])
    state = fresh_state()
    r = ir.check_feed({"name": "t", "url": url}, state, ["MaaS"])
    assert r["entries"][0]["matched"] == ["MaaS"]


def test_check_feed_seen_has_no_duplicates_across_runs(tmp_path):
    """毎回同じ記事を返すフィードで seen が重複膨張しないこと（バグ回帰）。"""
    url = write_rss(tmp_path, [(f"記事{i}", f"https://ex.com/{i}", "") for i in range(3)])
    state = fresh_state()
    for _ in range(5):
        ir.check_feed({"name": "t", "url": url}, state, [])
    seen = state["feeds"][url]["seen"]
    assert len(seen) == len(set(seen)) == 3


def test_check_feed_html_dispatch(tmp_path):
    url = write_html(tmp_path, HTML_PAGE)
    state = fresh_state()
    r = ir.check_feed(
        {"name": "t", "url": url, "type": "html", "link_pattern": "/press/article/"},
        state, [],
    )
    assert r["new_count"] == 3


# ---------- build_report ----------

def make_result(name, entries, first_run=False):
    return {"name": name, "first_run": first_run,
            "new_count": len(entries), "entries": entries}


def test_build_report_empty_says_no_news():
    report = ir.build_report({"猫": []}, [], NOW)
    assert "新着はありません。" in report
    assert "新着 **0** 件" in report


def test_build_report_stars_matched_and_sorts_first():
    entries = [
        {"title": "無印", "link": "u", "published": "", "matched": []},
        {"title": "重要", "link": "i", "published": "", "matched": ["定期券"]},
    ]
    report = ir.build_report({"C": [make_result("F", entries)]}, [], NOW)
    lines = [l for l in report.splitlines() if l.startswith("- ")]
    assert lines[0].startswith("- ★")          # マッチが先頭
    assert "`定期券`" in lines[0]
    assert lines[1].startswith("- [無印]")       # 無印は星なし


def test_build_report_error_section():
    report = ir.build_report({"C": []}, [("JR西", "http://x", "timeout")], NOW)
    assert "⚠️ 取得失敗" in report
    assert "JR西" in report and "timeout" in report
    assert "取得失敗 **1** 件" in report


def test_build_report_first_run_note():
    entries = [{"title": "A", "link": "u", "published": "", "matched": []}]
    r = make_result("F", entries, first_run=True)
    r["new_count"] = 20  # 全20件のうち1件表示という体
    report = ir.build_report({"C": [r]}, [], NOW)
    assert "初回取得" in report and "全20件" in report
