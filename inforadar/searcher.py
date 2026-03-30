"""ANA特典航空券の空席検索"""

import json
import time
from datetime import date, timedelta
from typing import Iterator

import requests
from bs4 import BeautifulSoup

from .models import FlightResult, Route, SearchConfig

# ANAの空席検索で使われる内部APIエンドポイント
ANA_AWARD_SEARCH_URL = "https://www.ana.co.jp/api/domesticaward/search"
ANA_INTL_AWARD_SEARCH_URL = "https://www.ana.co.jp/api/internationalaward/search"

# 国内主要空港コード
DOMESTIC_AIRPORTS = {
    "HND", "NRT", "TYO", "ITM", "KIX", "CTS", "FUK", "OKA",
    "NGO", "SDJ", "KOJ", "OIT", "KMI", "NGS", "TAK", "HIJ",
    "KMJ", "AOJ", "AKJ", "MMB", "OBO", "HKD", "GAJ", "SHM",
    "ISG", "MMY", "UBJ", "IZO", "TOY", "KMQ", "MYJ", "KCZ",
    "TKS", "TTJ", "IWJ", "NTQ", "AXT", "ONJ", "SYO",
}

# クラスコードの変換
CABIN_CLASS_MAP = {
    "Y": "Economy",
    "PY": "PremiumEconomy",
    "C": "Business",
    "F": "First",
}

# ANAの国内線マイルチャート（片道、レギュラーシーズン）
# P = プレミアムクラス（国内線のみ。国際線のビジネスとは別物）
DOMESTIC_MILES_CHART = {
    # (zone, cabin) -> miles
    ("0-300", "Y"): 5000,
    ("0-300", "P"): 9000,
    ("301-800", "Y"): 6000,
    ("301-800", "P"): 10500,
    ("801-1000", "Y"): 7000,
    ("801-1000", "P"): 12000,
    ("1001-2000", "Y"): 7500,
    ("1001-2000", "P"): 13500,
    ("2001+", "Y"): 10000,
    ("2001+", "P"): 18000,
}

# 主要国内路線の距離（km）と参考運賃（円）
DOMESTIC_ROUTE_DATA = {
    # 東京発
    ("TYO", "OKA"): {"distance": 1554, "base_price_y": 45000, "base_price_p": 75000},
    ("TYO", "CTS"): {"distance": 835, "base_price_y": 38000, "base_price_p": 65000},
    ("TYO", "FUK"): {"distance": 881, "base_price_y": 42000, "base_price_p": 70000},
    ("TYO", "KIX"): {"distance": 400, "base_price_y": 28000, "base_price_p": 48000},
    ("TYO", "ITM"): {"distance": 400, "base_price_y": 28000, "base_price_p": 48000},
    ("TYO", "NGO"): {"distance": 274, "base_price_y": 24000, "base_price_p": 42000},
    ("TYO", "HIJ"): {"distance": 675, "base_price_y": 35000, "base_price_p": 60000},
    ("TYO", "KOJ"): {"distance": 960, "base_price_y": 43000, "base_price_p": 72000},
    ("TYO", "KMJ"): {"distance": 904, "base_price_y": 42000, "base_price_p": 70000},
    ("TYO", "NGS"): {"distance": 958, "base_price_y": 43000, "base_price_p": 72000},
    ("TYO", "OIT"): {"distance": 825, "base_price_y": 40000, "base_price_p": 68000},
    ("TYO", "SDJ"): {"distance": 305, "base_price_y": 22000, "base_price_p": 38000},
    ("TYO", "AKJ"): {"distance": 1043, "base_price_y": 48000, "base_price_p": 80000},
    ("TYO", "MMB"): {"distance": 990, "base_price_y": 46000, "base_price_p": 78000},
    ("TYO", "ISG"): {"distance": 1950, "base_price_y": 55000, "base_price_p": 90000},
    # 大阪（伊丹）発
    ("ITM", "HND"): {"distance": 400, "base_price_y": 28000, "base_price_p": 48000},
    ("ITM", "CTS"): {"distance": 1150, "base_price_y": 40000, "base_price_p": 68000},
    ("ITM", "OKA"): {"distance": 1180, "base_price_y": 35000, "base_price_p": 60000},
    ("ITM", "SDJ"): {"distance": 620, "base_price_y": 30000, "base_price_p": 52000},
    ("ITM", "KMJ"): {"distance": 480, "base_price_y": 25000, "base_price_p": 44000},
    ("ITM", "NGS"): {"distance": 540, "base_price_y": 27000, "base_price_p": 46000},
    ("ITM", "KOJ"): {"distance": 560, "base_price_y": 28000, "base_price_p": 48000},
    ("ITM", "ISG"): {"distance": 1550, "base_price_y": 48000, "base_price_p": 80000},
    ("ITM", "MMB"): {"distance": 1300, "base_price_y": 45000, "base_price_p": 76000},
}

# 主要国際線マイルチャートと参考運賃
INTERNATIONAL_ROUTE_DATA = {
    ("TYO", "HNL"): {
        "miles": {"Y": 35000, "PY": 53000, "C": 60000, "F": 120000},
        "base_price": {"Y": 80000, "PY": 180000, "C": 350000, "F": 800000},
    },
    ("TYO", "SIN"): {
        "miles": {"Y": 30000, "PY": 46000, "C": 55000, "F": 105000},
        "base_price": {"Y": 70000, "PY": 150000, "C": 300000, "F": 700000},
    },
    ("TYO", "BKK"): {
        "miles": {"Y": 30000, "PY": 46000, "C": 55000, "F": 105000},
        "base_price": {"Y": 65000, "PY": 140000, "C": 280000, "F": 650000},
    },
    ("TYO", "LAX"): {
        "miles": {"Y": 40000, "PY": 62000, "C": 75000, "F": 150000},
        "base_price": {"Y": 120000, "PY": 250000, "C": 500000, "F": 1200000},
    },
    ("TYO", "JFK"): {
        "miles": {"Y": 40000, "PY": 62000, "C": 75000, "F": 150000},
        "base_price": {"Y": 130000, "PY": 280000, "C": 550000, "F": 1300000},
    },
    ("TYO", "LHR"): {
        "miles": {"Y": 38000, "PY": 57000, "C": 68000, "F": 130000},
        "base_price": {"Y": 110000, "PY": 230000, "C": 450000, "F": 1000000},
    },
    ("TYO", "CDG"): {
        "miles": {"Y": 38000, "PY": 57000, "C": 68000, "F": 130000},
        "base_price": {"Y": 115000, "PY": 240000, "C": 460000, "F": 1050000},
    },
    ("TYO", "SYD"): {
        "miles": {"Y": 37000, "PY": 56000, "C": 65000, "F": 125000},
        "base_price": {"Y": 100000, "PY": 220000, "C": 420000, "F": 950000},
    },
    # 関空発
    ("KIX", "TPE"): {
        "miles": {"Y": 17000, "PY": 26000, "C": 35000, "F": 0},
        "base_price": {"Y": 45000, "PY": 90000, "C": 180000, "F": 0},
    },
    ("KIX", "HNL"): {
        "miles": {"Y": 35000, "PY": 53000, "C": 60000, "F": 120000},
        "base_price": {"Y": 85000, "PY": 185000, "C": 360000, "F": 820000},
    },
}

WEEKDAY_MAP = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3,
    "fri": 4, "sat": 5, "sun": 6,
}


def is_domestic(route: Route) -> bool:
    """国内線かどうか判定"""
    return route.origin in DOMESTIC_AIRPORTS and route.destination in DOMESTIC_AIRPORTS


def get_distance_zone(distance_km: int) -> str:
    """距離からゾーンを取得"""
    if distance_km <= 300:
        return "0-300"
    elif distance_km <= 800:
        return "301-800"
    elif distance_km <= 1000:
        return "801-1000"
    elif distance_km <= 2000:
        return "1001-2000"
    else:
        return "2001+"


def generate_dates(config: SearchConfig) -> list[date]:
    """検索対象の日付リストを生成"""
    dates = []
    current = config.date_from
    weekday_filter = {WEEKDAY_MAP[w] for w in config.weekdays if w in WEEKDAY_MAP}

    while current <= config.date_to:
        if not weekday_filter or current.weekday() in weekday_filter:
            dates.append(current)
        current += timedelta(days=1)
    return dates


def search_route(
    route: Route,
    search_date: date,
    cabin_classes: list[str],
    rate_threshold: float,
) -> list[FlightResult]:
    """路線・日付・クラスの組み合わせで検索"""
    results = []
    route_key = (route.origin, route.destination)

    if is_domestic(route):
        route_data = DOMESTIC_ROUTE_DATA.get(route_key)
        if not route_data:
            return results

        distance = route_data["distance"]
        zone = get_distance_zone(distance)

        for cabin in cabin_classes:
            # 国内線: Y(普通席) または P(プレミアムクラス)
            # config上 "C" が来たら国内線では "P" に読み替え
            domestic_cabin = "P" if cabin in ("C", "P") else cabin
            if domestic_cabin not in ("Y", "P"):
                continue
            miles_key = (zone, domestic_cabin)
            miles = DOMESTIC_MILES_CHART.get(miles_key)
            if not miles:
                continue

            price_key = f"base_price_{domestic_cabin.lower()}"
            base_price = route_data.get(price_key, 0)
            if not base_price:
                continue

            # 日付による運賃変動をシミュレーション
            weekday = search_date.weekday()
            price_multiplier = 1.0
            if weekday in (4, 5):  # 金・土は割高
                price_multiplier = 1.3
            elif weekday in (0, 1, 2, 3):  # 平日は割安
                price_multiplier = 0.85

            adjusted_price = int(base_price * price_multiplier)

            # フライト番号を生成（模擬）
            flight_num = f"NH{100 + hash((route_key, search_date, domestic_cabin)) % 900}"
            dep_hour = 7 + hash((route_key, search_date)) % 12
            duration_h = max(1, distance // 600)
            duration_m = (distance % 600) // 10

            # プレミアムクラスの特典枠はごく少数（1便あたり0〜2席程度）
            # SFCでも取りにくい。平日は少しマシ。
            if domestic_cabin == "P":
                seed = hash((route_key, search_date, "premium_seats"))
                if weekday in (4, 5, 6):  # 金土日はほぼ取れない
                    seats = 1 if seed % 8 == 0 else 0
                else:  # 平日でも少ない
                    seats = min(2, max(0, seed % 4 - 1))
            else:
                seats = max(0, hash((route_key, search_date, domestic_cabin, "seats")) % 5)

            results.append(FlightResult(
                route=route,
                date=search_date,
                flight_number=flight_num,
                departure_time=f"{dep_hour:02d}:{hash(search_date.day) % 60:02d}",
                arrival_time=f"{dep_hour + duration_h:02d}:{(hash(search_date.day) % 60 + duration_m) % 60:02d}",
                cabin_class=domestic_cabin,
                miles_required=miles,
                cash_price=adjusted_price,
                taxes_and_fees=0,
                seats_available=seats,
            ))
    else:
        # 国際線
        intl_data = INTERNATIONAL_ROUTE_DATA.get(route_key)
        if not intl_data:
            return results

        for cabin in cabin_classes:
            # 国際線には "P"(プレミアムクラス) はない → Yとして扱う
            intl_cabin = cabin if cabin != "P" else "Y"
            # Y重複を避ける
            if intl_cabin == "Y" and cabin == "P" and "Y" in cabin_classes:
                continue
            miles = intl_data["miles"].get(intl_cabin)
            base_price = intl_data["base_price"].get(intl_cabin)
            if not miles or not base_price:
                continue

            # 国際線の税金・サーチャージ
            surcharge = {"Y": 15000, "PY": 20000, "C": 25000, "F": 30000}.get(intl_cabin, 15000)

            # 日付変動
            weekday = search_date.weekday()
            price_multiplier = 1.0
            if weekday in (4, 5):
                price_multiplier = 1.25
            elif weekday in (0, 1, 2, 3):
                price_multiplier = 0.9

            adjusted_price = int(base_price * price_multiplier)

            flight_num = f"NH{200 + hash((route_key, search_date, intl_cabin)) % 800}"
            dep_hour = 8 + hash((route_key, search_date)) % 14

            results.append(FlightResult(
                route=route,
                date=search_date,
                flight_number=flight_num,
                departure_time=f"{dep_hour:02d}:{hash(search_date.day) % 60:02d}",
                arrival_time="--:--",  # 国際線は到着時刻が複雑
                cabin_class=intl_cabin,
                miles_required=miles,
                cash_price=adjusted_price,
                taxes_and_fees=surcharge,
                seats_available=max(0, hash((route_key, search_date, cabin, "intl")) % 4),
            ))

    return results


def search_all(config: SearchConfig, verbose: bool = False) -> list[FlightResult]:
    """全路線・全日程で一括検索"""
    all_results = []
    dates = generate_dates(config)

    # 連休モードの場合、対象日のみに絞って検索
    if hasattr(config, '_renkyu_dates') and config._renkyu_dates:
        dates = [d for d in dates if d in config._renkyu_dates]

    total = len(config.routes) * len(dates)
    count = 0

    for route in config.routes:
        for search_date in dates:
            count += 1
            if verbose:
                print(f"  検索中... [{count}/{total}] {route} {search_date}")

            results = search_route(
                route, search_date, config.cabin_classes, config.rate_threshold
            )
            all_results.extend(results)

            if count < total and config.request_delay > 0:
                time.sleep(0)  # デモ用: 実API接続時はconfig.request_delayを使用

    return all_results
