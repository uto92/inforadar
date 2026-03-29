"""データモデル定義"""

from dataclasses import dataclass, field
from datetime import date
from typing import Optional


@dataclass
class Route:
    """路線情報"""
    origin: str
    destination: str

    def __str__(self) -> str:
        return f"{self.origin} → {self.destination}"


@dataclass
class FlightResult:
    """フライト検索結果"""
    route: Route
    date: date
    flight_number: str
    departure_time: str
    arrival_time: str
    cabin_class: str          # Y, PY, C, F
    miles_required: int       # 必要マイル数
    cash_price: int           # 有償航空券の価格（円）
    taxes_and_fees: int = 0   # 税金・サーチャージ（円）
    seats_available: int = 0  # 残席数

    @property
    def rate(self) -> float:
        """マイル単価（円/マイル）を計算"""
        if self.miles_required == 0:
            return 0.0
        return (self.cash_price - self.taxes_and_fees) / self.miles_required

    @property
    def is_available(self) -> bool:
        return self.seats_available > 0

    def rate_label(self, threshold: float = 2.0) -> str:
        """レートの評価ラベル"""
        if self.rate >= threshold * 2:
            return "★★★ 超お得"
        elif self.rate >= threshold * 1.5:
            return "★★ かなりお得"
        elif self.rate >= threshold:
            return "★ お得"
        else:
            return "普通"


@dataclass
class SearchConfig:
    """検索設定"""
    routes: list[Route] = field(default_factory=list)
    date_from: date = field(default_factory=date.today)
    date_to: date = field(default_factory=date.today)
    weekdays: list[str] = field(default_factory=list)
    cabin_classes: list[str] = field(default_factory=lambda: ["Y"])
    rate_threshold: float = 2.0
    request_delay: float = 3.0
    ana_username: Optional[str] = None
    ana_password: Optional[str] = None
