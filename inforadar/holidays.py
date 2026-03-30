"""日本の祝日・連休カレンダー"""

from datetime import date, timedelta
from dataclasses import dataclass


# 2026年の祝日
HOLIDAYS_2026 = {
    date(2026, 1, 1): "元日",
    date(2026, 1, 12): "成人の日",
    date(2026, 2, 11): "建国記念の日",
    date(2026, 2, 23): "天皇誕生日",
    date(2026, 3, 20): "春分の日",
    date(2026, 4, 29): "昭和の日",
    date(2026, 5, 3): "憲法記念日",
    date(2026, 5, 4): "みどりの日",
    date(2026, 5, 5): "こどもの日",
    date(2026, 5, 6): "振替休日",
    date(2026, 7, 20): "海の日",
    date(2026, 8, 11): "山の日",
    date(2026, 9, 21): "敬老の日",
    date(2026, 9, 23): "秋分の日",
    date(2026, 10, 12): "スポーツの日",
    date(2026, 11, 3): "文化の日",
    date(2026, 11, 23): "勤労感謝の日",
    # 2027年
    date(2027, 1, 1): "元日",
    date(2027, 1, 11): "成人の日",
    date(2027, 2, 11): "建国記念の日",
    date(2027, 2, 23): "天皇誕生日",
    date(2027, 3, 21): "春分の日",
    date(2027, 4, 29): "昭和の日",
    date(2027, 5, 3): "憲法記念日",
    date(2027, 5, 4): "みどりの日",
    date(2027, 5, 5): "こどもの日",
}


def is_holiday(d: date) -> bool:
    return d in HOLIDAYS_2026


def is_off(d: date) -> bool:
    """休日（土日祝）かどうか"""
    return d.weekday() >= 5 or is_holiday(d)


@dataclass
class Renkyu:
    """連休情報"""
    name: str
    start: date
    end: date
    days: int
    paid_leave_needed: int  # 有給必要日数

    def __str__(self) -> str:
        return f"{self.name}（{self.start.strftime('%m/%d')}〜{self.end.strftime('%m/%d')} {self.days}日間"

    def includes(self, d: date) -> bool:
        return self.start <= d <= self.end


def find_renkyus(year: int = 2026) -> list[Renkyu]:
    """連休（3日以上の連続休暇）を検出する"""
    # まず全ての休日ブロックを見つける
    start_date = date(year, 1, 1)
    end_date = date(year, 12, 31)

    renkyus = []

    # 既知の大型連休を先に定義
    known = _known_renkyus(year)
    renkyus.extend(known)

    # 自動検出: 3連休以上の土日祝ブロック
    current = start_date
    while current <= end_date:
        if is_off(current):
            block_start = current
            while current <= end_date and is_off(current):
                current += timedelta(days=1)
            block_end = current - timedelta(days=1)
            block_days = (block_end - block_start).days + 1

            if block_days >= 3:
                # 既知の連休と重複しないか確認
                already_known = any(
                    r.start <= block_start <= r.end or r.start <= block_end <= r.end
                    for r in known
                )
                if not already_known:
                    name = HOLIDAYS_2026.get(block_start) or HOLIDAYS_2026.get(block_end) or "3連休"
                    renkyus.append(Renkyu(
                        name=f"{name}連休",
                        start=block_start,
                        end=block_end,
                        days=block_days,
                        paid_leave_needed=0,
                    ))
        current += timedelta(days=1)

    # 有給1〜2日で作れる連休も提案
    renkyus.extend(_bridge_renkyus(year))

    renkyus.sort(key=lambda r: r.start)
    return renkyus


def _known_renkyus(year: int) -> list[Renkyu]:
    """既知の大型連休"""
    if year == 2026:
        return [
            Renkyu("GW前半", date(2026, 4, 29), date(2026, 4, 29), 1, 0),
            Renkyu("GW後半", date(2026, 5, 2), date(2026, 5, 6), 5, 1),
            # 5/2に有給取れば4/29〜5/6の8連休
            Renkyu("GW最大", date(2026, 4, 29), date(2026, 5, 6), 8, 2),
            Renkyu("お盆", date(2026, 8, 8), date(2026, 8, 16), 9, 4),
            Renkyu("SW（シルバーウィーク）", date(2026, 9, 19), date(2026, 9, 23), 5, 0),
            Renkyu("年末年始", date(2026, 12, 29), date(2027, 1, 4), 7, 3),
        ]
    return []


def _bridge_renkyus(year: int) -> list[Renkyu]:
    """有給1〜2日で作れる飛び石連休"""
    bridges = []
    if year == 2026:
        bridges = [
            Renkyu("海の日+有給1日", date(2026, 7, 18), date(2026, 7, 21), 4, 1),
            Renkyu("山の日+有給1日", date(2026, 8, 8), date(2026, 8, 11), 4, 1),
            Renkyu("敬老の日+秋分の日", date(2026, 9, 19), date(2026, 9, 23), 5, 2),
            Renkyu("文化の日+有給1日", date(2026, 11, 1), date(2026, 11, 3), 3, 1),
            Renkyu("勤労感謝の日+有給1日", date(2026, 11, 21), date(2026, 11, 23), 3, 1),
        ]
    return bridges


def filter_dates_by_renkyu(
    dates: list[date],
    renkyus: list[Renkyu],
    include_adjacent: int = 1,
) -> list[date]:
    """連休に含まれる日付（前後の日も含む）をフィルタ"""
    renkyu_dates = set()
    for r in renkyus:
        expanded_start = r.start - timedelta(days=include_adjacent)
        expanded_end = r.end + timedelta(days=include_adjacent)
        current = expanded_start
        while current <= expanded_end:
            renkyu_dates.add(current)
            current += timedelta(days=1)

    return [d for d in dates if d in renkyu_dates]
