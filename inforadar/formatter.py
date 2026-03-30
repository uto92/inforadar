"""検索結果のフォーマットと表示"""

from tabulate import tabulate

from .models import FlightResult


def format_results(
    results: list[FlightResult],
    rate_threshold: float = 2.0,
    only_available: bool = True,
    only_good_deals: bool = False,
    sort_by_rate: bool = True,
    min_seats: int = 1,
) -> str:
    """検索結果をテーブル形式でフォーマット"""

    filtered = results
    if only_available:
        filtered = [r for r in filtered if r.seats_available >= min_seats]
    if only_good_deals:
        filtered = [r for r in filtered if r.rate >= rate_threshold]
    if sort_by_rate:
        filtered.sort(key=lambda r: r.rate, reverse=True)

    if not filtered:
        return "該当するフライトが見つかりませんでした。"

    headers = [
        "路線", "日付", "便名", "出発", "到着", "クラス",
        "必要マイル", "有償価格", "税等", "マイル単価", "残席", "評価",
    ]

    rows = []
    for r in filtered:
        rows.append([
            str(r.route),
            r.date.strftime("%m/%d(%a)"),
            r.flight_number,
            r.departure_time,
            r.arrival_time,
            _cabin_label(r.cabin_class),
            f"{r.miles_required:,}",
            f"¥{r.cash_price:,}",
            f"¥{r.taxes_and_fees:,}" if r.taxes_and_fees else "-",
            f"{r.rate:.2f}円/マイル",
            str(r.seats_available) if r.seats_available > 0 else "-",
            r.rate_label(rate_threshold),
        ])

    return tabulate(rows, headers=headers, tablefmt="simple")


def format_summary(
    results: list[FlightResult],
    rate_threshold: float = 2.0,
    min_seats: int = 1,
) -> str:
    """検索結果のサマリーを出力"""
    available = [r for r in results if r.seats_available >= min_seats]
    good_deals = [r for r in available if r.rate >= rate_threshold]

    lines = [
        "=" * 60,
        "検索結果サマリー",
        "=" * 60,
        f"  検索フライト数:   {len(results)}",
        f"  空席あり:         {len(available)}",
        f"  お得なレート:     {len(good_deals)} （{rate_threshold}円/マイル以上）",
    ]

    if good_deals:
        best = max(good_deals, key=lambda r: r.rate)
        lines.extend([
            "",
            f"  ベストレート: {best.rate:.2f}円/マイル",
            f"    {best.route} {best.date} {best.flight_number} ({_cabin_label(best.cabin_class)})",
            f"    有償: ¥{best.cash_price:,} → 特典: {best.miles_required:,}マイル + ¥{best.taxes_and_fees:,}",
        ])

    # 路線別ベストレート
    routes_seen = set()
    route_bests = []
    for r in sorted(available, key=lambda r: r.rate, reverse=True):
        key = (str(r.route), r.cabin_class)
        if key not in routes_seen:
            routes_seen.add(key)
            route_bests.append(r)

    if route_bests:
        lines.extend(["", "路線別ベストレート:"])
        for r in route_bests[:10]:
            deal_mark = " ★" if r.rate >= rate_threshold else ""
            lines.append(
                f"  {str(r.route):20s} {_cabin_label(r.cabin_class):8s} "
                f"{r.rate:.2f}円/マイル ({r.date} {r.flight_number}){deal_mark}"
            )

    lines.append("=" * 60)
    return "\n".join(lines)


def _cabin_label(code: str) -> str:
    """クラスコードをラベルに変換"""
    return {
        "Y": "エコノミー",
        "PY": "Pエコノミー",
        "C": "ビジネス",
        "F": "ファースト",
    }.get(code, code)
