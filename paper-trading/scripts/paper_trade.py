#!/usr/bin/env python3
"""ペーパートレード管理CLI (標準ライブラリのみ)

使い方:
  python3 paper_trade.py report                      損益レポート表示
  python3 paper_trade.py buy  7974 100 7300 [-d 日付] [-n メモ]
  python3 paper_trade.py sell 7974 100 7500 [-d 日付] [-n メモ]
  python3 paper_trade.py price 7974 7350 [-d 日付]   時価を更新
  python3 paper_trade.py deposit 1000000             現金を追加入金
"""
import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTFOLIO = ROOT / "portfolio.json"
TRADES = ROOT / "trades.csv"


def load():
    return json.loads(PORTFOLIO.read_text(encoding="utf-8"))


def save(p):
    PORTFOLIO.write_text(
        json.dumps(p, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def append_trade(row):
    with TRADES.open("a", encoding="utf-8", newline="") as f:
        csv.writer(f).writerow(row)


def cmd_buy(args):
    p = load()
    amount = args.qty * args.price
    if amount > p["cash"]:
        sys.exit(f"現金不足: 必要 {amount:,.0f} 円 / 残高 {p['cash']:,.0f} 円")
    pos = p["positions"].get(args.code)
    if pos:
        total_cost = pos["avg_cost"] * pos["qty"] + amount
        pos["qty"] += args.qty
        pos["avg_cost"] = round(total_cost / pos["qty"], 4)
    else:
        name = args.name or args.code
        pos = {"name": name, "qty": args.qty, "avg_cost": float(args.price)}
        p["positions"][args.code] = pos
    pos["last_price"] = float(args.price)
    pos["last_price_date"] = args.date
    p["cash"] -= amount
    p["as_of"] = args.date
    save(p)
    append_trade([args.date, args.code, pos["name"], "BUY",
                  args.qty, args.price, amount, args.note])
    print(f"買付: {pos['name']} {args.qty}株 @{args.price:,.0f}円 "
          f"(約定代金 {amount:,.0f}円 / 現金残 {p['cash']:,.0f}円)")


def cmd_sell(args):
    p = load()
    pos = p["positions"].get(args.code)
    if not pos or pos["qty"] < args.qty:
        held = pos["qty"] if pos else 0
        sys.exit(f"保有不足: {args.code} 保有 {held}株 / 売却指定 {args.qty}株")
    amount = args.qty * args.price
    realized = (args.price - pos["avg_cost"]) * args.qty
    pos["qty"] -= args.qty
    pos["last_price"] = float(args.price)
    pos["last_price_date"] = args.date
    name = pos["name"]
    if pos["qty"] == 0:
        del p["positions"][args.code]
    p["cash"] += amount
    p["realized_pnl"] = round(p.get("realized_pnl", 0) + realized, 2)
    p["as_of"] = args.date
    save(p)
    append_trade([args.date, args.code, name, "SELL",
                  args.qty, args.price, amount, args.note])
    print(f"売却: {name} {args.qty}株 @{args.price:,.0f}円 "
          f"(実現損益 {realized:+,.0f}円 / 現金残 {p['cash']:,.0f}円)")


def cmd_price(args):
    p = load()
    pos = p["positions"].get(args.code)
    if not pos:
        sys.exit(f"未保有の銘柄です: {args.code}")
    pos["last_price"] = float(args.price)
    pos["last_price_date"] = args.date
    pos.pop("note", None)
    p["as_of"] = args.date
    save(p)
    print(f"時価更新: {pos['name']} → {args.price:,.0f}円 ({args.date})")


def cmd_deposit(args):
    p = load()
    p["cash"] += args.amount
    p["initial_capital"] += args.amount
    save(p)
    print(f"入金: {args.amount:,.0f}円 (現金残 {p['cash']:,.0f}円)")


def cmd_report(_args):
    p = load()
    print(f"=== ペーパートレード レポート (時価基準日: {p['as_of']}) ===\n")
    header = f"{'コード':<6} {'銘柄':<10} {'株数':>6} {'平均取得':>10} {'時価':>10} {'評価額':>12} {'評価損益':>12} {'損益率':>8}"
    print(header)
    print("-" * len(header))
    total_value = 0.0
    total_cost = 0.0
    for code, pos in sorted(p["positions"].items()):
        value = pos["qty"] * pos["last_price"]
        cost = pos["qty"] * pos["avg_cost"]
        pnl = value - cost
        rate = pnl / cost * 100 if cost else 0
        total_value += value
        total_cost += cost
        print(f"{code:<6} {pos['name']:<10} {pos['qty']:>6} "
              f"{pos['avg_cost']:>10,.0f} {pos['last_price']:>10,.0f} "
              f"{value:>12,.0f} {pnl:>+12,.0f} {rate:>+7.2f}%")
    unrealized = total_value - total_cost
    equity = p["cash"] + total_value
    total_pnl = equity - p["initial_capital"]
    print("-" * len(header))
    print(f"\n株式評価額 : {total_value:>14,.0f} 円")
    print(f"現金残高   : {p['cash']:>14,.0f} 円")
    print(f"資産合計   : {equity:>14,.0f} 円")
    print(f"評価損益   : {unrealized:>+14,.0f} 円")
    print(f"実現損益   : {p.get('realized_pnl', 0):>+14,.0f} 円")
    print(f"トータル   : {total_pnl:>+14,.0f} 円 "
          f"({total_pnl / p['initial_capital'] * 100:+.2f}%)")


def main():
    today = date.today().isoformat()
    ap = argparse.ArgumentParser(description="ペーパートレード管理")
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name in ("buy", "sell"):
        sp = sub.add_parser(name)
        sp.add_argument("code")
        sp.add_argument("qty", type=int)
        sp.add_argument("price", type=float)
        sp.add_argument("-d", "--date", default=today)
        sp.add_argument("-n", "--note", default="")
        if name == "buy":
            sp.add_argument("--name", default="", help="新規銘柄の表示名")

    sp = sub.add_parser("price")
    sp.add_argument("code")
    sp.add_argument("price", type=float)
    sp.add_argument("-d", "--date", default=today)

    sp = sub.add_parser("deposit")
    sp.add_argument("amount", type=int)

    sub.add_parser("report")

    args = ap.parse_args()
    {"buy": cmd_buy, "sell": cmd_sell, "price": cmd_price,
     "deposit": cmd_deposit, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
