"""レポート生成: analyze の report_data.json を単一の自己完結 HTML にレンダリングする。

- データは JSON として HTML に埋め込む(外部ファイル参照なし)
- Chart.js / Leaflet は CDN 読み込み(オフライン時は表のみ表示のバナーを出す)
- lat/lon が deployments に無い場合、マップセクションは出力しない
"""

from __future__ import annotations

import json
from pathlib import Path

from jinja2 import Environment, PackageLoader, select_autoescape

from .config import ensure_dir


def render_report(data: dict) -> str:
    env = Environment(
        loader=PackageLoader("bleflow", "templates"),
        autoescape=select_autoescape(["html", "j2"]),
    )
    template = env.get_template("report.html.j2")
    # </script> インジェクション対策として "</" をエスケープして埋め込む
    data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return template.render(data=data, data_json=data_json)


def run_report(settings: dict) -> Path:
    json_path = Path(settings["paths"]["output_dir"]) / "analysis" / "report_data.json"
    if not json_path.exists():
        raise FileNotFoundError(
            f"{json_path} がありません。先に `bleflow analyze` を実行してください。"
        )
    data = json.loads(json_path.read_text(encoding="utf-8"))
    html = render_report(data)
    out_path = Path(settings["report"]["file"])
    ensure_dir(out_path.parent)
    out_path.write_text(html, encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"[report] {out_path}({size_kb:,.0f} KB)を生成しました。ブラウザで開いてください。")
    return out_path
