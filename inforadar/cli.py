"""CLI エントリーポイント"""

import argparse
import sys

from . import __version__
from .config import load_config
from .formatter import format_results, format_summary
from .searcher import search_all


def main():
    parser = argparse.ArgumentParser(
        description="ANA SFC お得レート自動検索ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  python -m inforadar                        設定ファイルで検索
  python -m inforadar -c my_config.yaml      カスタム設定で検索
  python -m inforadar --deals-only           お得なレートのみ表示
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
        "--version",
        action="version",
        version=f"inforadar {__version__}",
    )

    args = parser.parse_args()

    print(f"🔍 InfoRadar v{__version__} - ANA SFC お得レート検索")
    print()

    try:
        config = load_config(args.config)
    except FileNotFoundError as e:
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)

    if args.threshold is not None:
        config.rate_threshold = args.threshold

    print(f"検索期間: {config.date_from} ～ {config.date_to}")
    print(f"路線数: {len(config.routes)}")
    print(f"クラス: {', '.join(config.cabin_classes)}")
    print(f"お得判定閾値: {config.rate_threshold}円/マイル")
    print()

    results = search_all(config, verbose=args.verbose)

    if not results:
        print("検索結果がありません。config.yaml の設定を確認してください。")
        sys.exit(0)

    # サマリー表示
    print(format_summary(results, config.rate_threshold))
    print()

    # 詳細テーブル表示
    print(format_results(
        results,
        rate_threshold=config.rate_threshold,
        only_available=not args.show_all,
        only_good_deals=args.deals_only,
    ))


if __name__ == "__main__":
    main()
