"""CLI エントリーポイント"""

import argparse
import sys

from . import __version__
from .config import load_config
from .formatter import format_results, format_summary
from .holidays import find_renkyus, filter_dates_by_renkyu, Renkyu
from .searcher import search_all, generate_dates


def main():
    parser = argparse.ArgumentParser(
        description="ANA SFC お得レート自動検索ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  python -m inforadar                        設定ファイルで検索
  python -m inforadar --renkyu               連休に絞って検索
  python -m inforadar --renkyu --deals-only  連休のお得レートのみ
  python -m inforadar -c my_config.yaml      カスタム設定で検索
  python -m inforadar --threshold 3.0        閾値を3円/マイルに設定
        """,
    )
    parser.add_argument(
        "-c", "--config",
        default="config.yaml",
        help="設定ファイルのパス（デフォルト: config.yaml）",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="詳細な検索進捗を表示",
    )
    parser.add_argument(
        "--deals-only",
        action="store_true",
        help="お得なレート（閾値以上）のみ表示",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="お得判定の閾値（円/マイル）",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        dest="show_all",
        help="空席なしのフライトも表示",
    )
    parser.add_argument(
        "--renkyu",
        action="store_true",
        help="連休（GW・お盆・SW・年末年始等）に絞って検索",
    )
    parser.add_argument(
        "--renkyu-list",
        action="store_true",
        help="2026年の連休カレンダーを表示",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"inforadar {__version__}",
    )

    args = parser.parse_args()

    print(f"🔍 InfoRadar v{__version__} - ANA SFC お得レート検索")
    print()

    # 連休カレンダー表示
    if args.renkyu_list:
        _show_renkyu_calendar()
        return

    try:
        config = load_config(args.config)
    except FileNotFoundError as e:
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    if args.threshold is not None:
        config.rate_threshold = args.threshold

    # 連休モードの場合、検索範囲を年間に拡大
    if args.renkyu:
        from datetime import date
        config.date_from = date(2026, 4, 1)
        config.date_to = date(2027, 1, 5)
        renkyus = find_renkyus(2026)
        all_dates = generate_dates(config)
        renkyu_dates = set()
        for d in filter_dates_by_renkyu(all_dates, renkyus, include_adjacent=1):
            renkyu_dates.add(d)
        config._renkyu_dates = renkyu_dates
        config._renkyus = renkyus

        print("📅 連休モード: 連休期間に絞って検索します")
        print()
        _show_renkyu_calendar()
        print()

    print(f"検索期間: {config.date_from} ～ {config.date_to}")
    print(f"路線数: {len(config.routes)}")
    print(f"クラス: {', '.join(config.cabin_classes)}")
    print(f"お得判定閾値: {config.rate_threshold}円/マイル")
    if args.renkyu:
        print(f"対象: 連休期間のみ")
    print()

    results = search_all(config, verbose=args.verbose)

    # 連休モードの場合、連休日付のみにフィルタ
    if args.renkyu and hasattr(config, '_renkyu_dates'):
        results = [r for r in results if r.date in config._renkyu_dates]

    if not results:
        print("検索結果がありません。config.yaml の設定を確認してください。")
        sys.exit(0)

    # サマリー表示
    print(format_summary(results, config.rate_threshold))
    print()

    # 連休別おすすめ表示
    if args.renkyu and hasattr(config, '_renkyus'):
        print(_format_renkyu_suggestions(results, config._renkyus, config.rate_threshold))
        print()

    # 詳細テーブル表示
    print(format_results(
        results,
        rate_threshold=config.rate_threshold,
        only_available=not args.show_all,
        only_good_deals=args.deals_only,
    ))


def _show_renkyu_calendar():
    """連休カレンダーを表示"""
    renkyus = find_renkyus(2026)
    print("📅 2026年 連休カレンダー")
    print("=" * 65)
    seen = set()
    for r in renkyus:
        key = (r.name, r.start)
        if key in seen:
            continue
        seen.add(key)
        leave_note = ""
        if r.paid_leave_needed > 0:
            leave_note = f"  💡有給{r.paid_leave_needed}日で実現"
        print(
            f"  {r.start.strftime('%m/%d(%a)')} ～ "
            f"{r.end.strftime('%m/%d(%a)')}  "
            f"{r.days}日間  {r.name}{leave_note}"
        )
    print("=" * 65)


def _format_renkyu_suggestions(
    results: list,
    renkyus: list[Renkyu],
    rate_threshold: float,
) -> str:
    """連休別のおすすめを表示"""
    from .formatter import _cabin_label

    lines = ["=" * 65, "🎌 連休別おすすめフライト", "=" * 65]

    seen_renkyus = set()
    for r in renkyus:
        if r.name in seen_renkyus:
            continue
        seen_renkyus.add(r.name)

        # この連休期間のフライトを抽出
        renkyu_results = [
            f for f in results
            if r.start <= f.date <= r.end and f.is_available
        ]
        if not renkyu_results:
            continue

        # レート順にソート
        renkyu_results.sort(key=lambda f: f.rate, reverse=True)

        lines.append(f"\n▶ {r.name}（{r.start.strftime('%m/%d')}〜{r.end.strftime('%m/%d')} {r.days}日間）")
        if r.paid_leave_needed > 0:
            lines.append(f"  💡 有給{r.paid_leave_needed}日取得で実現")

        # 路線別ベストを表示（最大5件）
        seen_routes = set()
        count = 0
        for f in renkyu_results:
            route_key = (str(f.route), f.cabin_class)
            if route_key in seen_routes:
                continue
            seen_routes.add(route_key)
            count += 1
            if count > 5:
                break

            deal_mark = ""
            if f.rate >= rate_threshold * 2:
                deal_mark = " ★★★"
            elif f.rate >= rate_threshold * 1.5:
                deal_mark = " ★★"
            elif f.rate >= rate_threshold:
                deal_mark = " ★"

            lines.append(
                f"    {str(f.route):16s} {f.date.strftime('%m/%d(%a)')} "
                f"{_cabin_label(f.cabin_class):8s} "
                f"{f.rate:.1f}円/マイル "
                f"({f.miles_required:,}マイル → 有償¥{f.cash_price:,}) "
                f"残{f.seats_available}席{deal_mark}"
            )

    lines.append("=" * 65)
    return "\n".join(lines)


if __name__ == "__main__":
    main()
