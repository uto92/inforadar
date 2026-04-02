"""Flask Webアプリ"""

from datetime import date

from flask import Flask, render_template, request

from .config import load_config
from .formatter import _cabin_label
from .holidays import find_renkyus, filter_dates_by_renkyu
from .searcher import search_all, generate_dates

app = Flask(__name__)


def _get_config():
    config = load_config("config.yaml")
    return config


@app.route("/")
def index():
    renkyus = find_renkyus(2026)
    config = _get_config()
    return render_template("index.html", renkyus=renkyus, config=config)


@app.route("/search")
def search():
    config = _get_config()

    # パラメータ取得
    renkyu_name = request.args.get("renkyu", "")
    min_seats = int(request.args.get("min_seats", 2))
    threshold = float(request.args.get("threshold", config.rate_threshold))
    config.rate_threshold = threshold

    renkyus = find_renkyus(2026)

    # 連休選択時はその期間に絞る
    selected_renkyu = None
    if renkyu_name:
        for r in renkyus:
            if r.name == renkyu_name:
                selected_renkyu = r
                config.date_from = r.start
                config.date_to = r.end
                break

    results = search_all(config)

    # フィルタ: 残席数・お得レート
    results = [
        r for r in results
        if r.seats_available >= min_seats and r.rate >= threshold
    ]
    results.sort(key=lambda r: r.rate, reverse=True)

    # 路線別ベスト
    route_bests = []
    seen = set()
    for r in results:
        key = (str(r.route), r.cabin_class)
        if key not in seen:
            seen.add(key)
            route_bests.append(r)

    return render_template(
        "results.html",
        results=results,
        route_bests=route_bests[:10],
        selected_renkyu=selected_renkyu,
        min_seats=min_seats,
        threshold=threshold,
        renkyus=renkyus,
        config=config,
        cabin_label=_cabin_label,
        total=len(results),
    )


def main():
    app.run(debug=True, host="0.0.0.0", port=5000)


if __name__ == "__main__":
    main()
