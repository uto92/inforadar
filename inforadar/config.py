"""設定ファイルの読み込み"""

import os
from datetime import date, timedelta
from pathlib import Path

import yaml

from .models import Route, SearchConfig


def load_config(config_path: str = "config.yaml") -> SearchConfig:
    """YAMLファイルから設定を読み込む"""
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"設定ファイルが見つかりません: {config_path}")

    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    routes = [
        Route(origin=r["origin"], destination=r["destination"])
        for r in raw.get("routes", [])
    ]

    search = raw.get("search", {})
    today = date.today()
    date_from = _parse_date(search.get("date_from"), default=today + timedelta(days=7))
    date_to = _parse_date(search.get("date_to"), default=today + timedelta(days=37))

    weekdays = [d.lower() for d in search.get("weekdays", [])]

    cabin_classes = raw.get("cabin_classes", ["Y"])
    rate_threshold = float(raw.get("rate_threshold", 2.0))
    request_delay = float(raw.get("request_delay", 3.0))

    # 認証情報は環境変数を優先
    creds = raw.get("ana_credentials", {})
    username = os.environ.get("ANA_USERNAME") or creds.get("username")
    password = os.environ.get("ANA_PASSWORD") or creds.get("password")

    return SearchConfig(
        routes=routes,
        date_from=date_from,
        date_to=date_to,
        weekdays=weekdays,
        cabin_classes=cabin_classes,
        rate_threshold=rate_threshold,
        request_delay=request_delay,
        ana_username=username,
        ana_password=password,
    )


def _parse_date(value, default: date) -> date:
    if value is None:
        return default
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))
