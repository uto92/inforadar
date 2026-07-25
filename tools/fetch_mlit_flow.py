#!/usr/bin/env python3
"""国土交通省「全国の人流オープンデータ」(1kmメッシュ)を取得し、
inforadar の実データモード用 data/flow_mesh.js を生成するスクリプト。

データセット: https://www.geospatial.jp/ckan/dataset/mlit-1km-fromto
(スマートフォンの位置情報をもとにした1kmメッシュ別滞在人口。
 平日/休日 × 昼(11-15時)/深夜(1-5時) の区分で月別に公開)

使い方(リポジトリ直下で実行):

    # まず利用可能なリソース(ファイル)一覧を確認
    python3 tools/fetch_mlit_flow.py --list

    # 近畿6府県 × 2019年11月 を取得して data/flow_mesh.js を生成
    python3 tools/fetch_mlit_flow.py --prefs 25 26 27 28 29 30 --months 2019-11

    # 全掲載駅の周辺(デフォルト半径3km)ではなく全メッシュを残す場合
    python3 tools/fetch_mlit_flow.py --prefs 27 --months 2019-11 --radius 0

府県コード例: 25滋賀 26京都 27大阪 28兵庫 29奈良 30和歌山
             33岡山 34広島 35山口 31鳥取 32島根 16富山 17石川 18福井

注意: データの利用にあたっては G空間情報センターの利用規約に従ってください。
"""

import argparse
import csv
import io
import json
import math
import re
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

CKAN_API = "https://www.geospatial.jp/ckan/api/3/action/package_show?id=mlit-1km-fromto"
REPO_ROOT = Path(__file__).resolve().parent.parent
STATIONS_JS = REPO_ROOT / "data" / "stations.js"
OUT_JS = REPO_ROOT / "data" / "flow_mesh.js"
CACHE_DIR = REPO_ROOT / ".cache" / "mlit"

UA = {"User-Agent": "inforadar-fetch/1.0 (open-data ingest script)"}


# ---------------------------------------------------------------- mesh utils

def mesh1km_to_center(mesh: str):
    """8桁の3次メッシュ(1km)コード → 中心の(lat, lon)。"""
    m = str(mesh).strip()
    if not re.fullmatch(r"\d{8}", m):
        return None
    ab, cd = int(m[0:2]), int(m[2:4])
    e, f, g, h = int(m[4]), int(m[5]), int(m[6]), int(m[7])
    lat_sw = ab / 1.5 + e / 12 + g / 120
    lon_sw = 100 + cd + f / 8 + h / 80
    return (lat_sw + 1 / 240, lon_sw + 1 / 160)


def selftest():
    lat, lon = mesh1km_to_center("53393599")  # 東京タワー付近
    assert abs(lat - 35.6625) < 1e-6 and abs(lon - 139.74375) < 1e-6, (lat, lon)
    print("selftest OK: 53393599 ->", lat, lon)


# ---------------------------------------------------------------- stations

def load_station_coords():
    """data/stations.js から駅座標を正規表現で抽出する。"""
    text = STATIONS_JS.read_text(encoding="utf-8")
    coords = [
        (float(a), float(b))
        for a, b in re.findall(r"lat:\s*([\d.]+),\s*lon:\s*([\d.]+)", text)
    ]
    if not coords:
        sys.exit(f"駅座標を {STATIONS_JS} から読み取れませんでした")
    return coords


def dist_km(lat1, lon1, lat2, lon2):
    dx = (lon2 - lon1) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 111.32
    return math.hypot(dx, dy)


# ---------------------------------------------------------------- CKAN

def fetch_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return json.load(r)


def list_resources():
    data = fetch_json(CKAN_API)
    if not data.get("success"):
        sys.exit("CKAN APIの応答が success ではありません")
    return data["result"]["resources"]


def pick_resources(resources, prefs, months):
    """府県コード・年に合致しそうなリソースを選ぶ。

    公開ファイルの命名は年度によって揺れがあるため、名前とURLの双方から
    2桁府県コードと年(YYYY)を拾う緩めのマッチにしている。
    """
    years = {m.split("-")[0] for m in months}
    picked = []
    for r in resources:
        hay = f"{r.get('name','')} {r.get('url','')}".lower()
        if "mesh1km" not in hay.replace("_", "").replace("-", ""):
            if "1km" not in hay:
                continue
        if not any(y in hay for y in years):
            continue
        for p in prefs:
            # _27_ / _27. / pref27 などを許容
            if re.search(rf"(?<!\d){p:02d}(?!\d)", hay):
                picked.append((p, r))
                break
    return picked


# ---------------------------------------------------------------- download

def download(url, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  cached: {dest.name}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading: {url}")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        tmp = dest.with_suffix(".part")
        with open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        tmp.rename(dest)
    return dest


def iter_csv_rows(path: Path):
    """zip(入れ子zip対応)または素のCSVから行(dict)をyield。"""

    def from_bytes(name, blob):
        if name.lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                for inner in z.namelist():
                    if inner.lower().endswith((".csv", ".zip")):
                        yield from from_bytes(inner, z.read(inner))
        elif name.lower().endswith(".csv"):
            text = blob.decode("utf-8-sig", errors="replace")
            yield from csv.DictReader(io.StringIO(text))

    yield from from_bytes(path.name, path.read_bytes())


def col(row, *cands):
    """列名の揺れを吸収して値を取り出す。"""
    for k in row:
        lk = k.lower().strip()
        for c in cands:
            if c in lk:
                return row[k]
    return None


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="CKAN上のリソース一覧を表示して終了")
    ap.add_argument("--prefs", nargs="+", type=int, default=[25, 26, 27, 28, 29, 30],
                    help="府県コード(2桁, 複数可)。デフォルト: 近畿6府県")
    ap.add_argument("--months", nargs="+", default=["2019-11"],
                    help="対象年月 YYYY-MM(複数指定時は平均)。デフォルト: 2019-11")
    ap.add_argument("--radius", type=float, default=3.0,
                    help="駅からこの半径(km)内のメッシュのみ残す。0で無効(全メッシュ)")
    ap.add_argument("--url", nargs="+", default=[],
                    help="CKAN検索を使わず、ZIP/CSVのURLを直接指定")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return

    if args.list:
        for r in list_resources():
            print(f"{r.get('name','(no name)')}\n    {r.get('url','')}")
        return

    months = []
    for m in args.months:
        mm = re.fullmatch(r"(\d{4})-(\d{1,2})", m)
        if not mm:
            sys.exit(f"--months は YYYY-MM 形式で指定してください: {m}")
        months.append((int(mm.group(1)), int(mm.group(2))))
    month_strs = [f"{y}-{mo:02d}" for y, mo in months]

    # 1) ダウンロード対象を決める
    if args.url:
        files = [download(u, CACHE_DIR / Path(u).name.split("?")[0]) for u in args.url]
    else:
        print("CKAN APIからリソース一覧を取得中…")
        picked = pick_resources(list_resources(), args.prefs, month_strs)
        if not picked:
            sys.exit("対象リソースが見つかりませんでした。--list で一覧を確認し、"
                     "--url で直接URLを指定してください。")
        print(f"{len(picked)} 件のリソースをダウンロードします")
        files = [download(r["url"], CACHE_DIR / Path(r["url"]).name.split("?")[0])
                 for _, r in picked]

    # 2) CSVを読んで (mesh, dayflag, timezone) ごとに集計
    want_months = {(y, mo) for y, mo in months}
    acc = defaultdict(list)  # (mesh, dayflag, timezone) -> [population,...]
    nrows = 0
    for path in files:
        print(f"  parsing: {path.name}")
        for row in iter_csv_rows(path):
            mesh = col(row, "mesh")
            day = col(row, "dayflag", "day_flag")
            tz = col(row, "timezone", "time_zone", "timeflag")
            pop = col(row, "population", "pop")
            y, mo = col(row, "year"), col(row, "month")
            if None in (mesh, day, tz, pop):
                continue
            try:
                if y is not None and mo is not None and (int(y), int(mo)) not in want_months:
                    continue
                day, tz, pop = int(day), int(tz), float(pop)
            except ValueError:
                continue
            if day in (0, 1) and tz in (0, 1):  # 0=休日/昼, 1=平日/深夜
                acc[(str(mesh).strip(), day, tz)].append(pop)
                nrows += 1
    if not acc:
        sys.exit("CSVから対象行を読み取れませんでした(列名・年月指定を確認してください)")
    print(f"{nrows} 行を集計しました")

    # 3) メッシュ→座標、駅近傍フィルタ
    stations = load_station_coords()
    cells = {}
    for (mesh, day, tz), pops in acc.items():
        if mesh not in cells:
            c = mesh1km_to_center(mesh)
            if c is None:
                continue
            cells[mesh] = {"lat": round(c[0], 5), "lon": round(c[1], 5),
                           "wd": 0, "wn": 0, "hd": 0, "hn": 0}
        v = round(sum(pops) / len(pops))
        key = {(1, 0): "wd", (1, 1): "wn", (0, 0): "hd", (0, 1): "hn"}[(day, tz)]
        cells[mesh][key] = v

    out = list(cells.values())
    if args.radius > 0:
        out = [c for c in out
               if any(dist_km(c["lat"], c["lon"], sa, so) <= args.radius
                      for sa, so in stations)]
        print(f"駅から半径{args.radius}km以内のメッシュ: {len(out)} 個")
    else:
        print(f"全メッシュ: {len(out)} 個")
    if not out:
        sys.exit("メッシュが0個になりました。--radius や対象府県を見直してください。")

    out.sort(key=lambda c: (-max(c["wd"], c["hd"]), c["lat"], c["lon"]))

    # 4) 書き出し
    meta = {
        "source": "mlit-1km-fromto",
        "sourceName": "国土交通省 全国の人流オープンデータ(1kmメッシュ)",
        "sourceUrl": "https://www.geospatial.jp/ckan/dataset/mlit-1km-fromto",
        "months": month_strs,
        "prefs": args.prefs,
        "radiusKm": args.radius,
        "cellCount": len(out),
    }
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// このファイルは tools/fetch_mlit_flow.py により生成されました\n")
        f.write("// 出典: 「全国の人流オープンデータ」(国土交通省) を加工して作成\n")
        f.write(f"const FLOW_MESH = {{\n  meta: {json.dumps(meta, ensure_ascii=False)},\n")
        f.write("  // wd=平日昼(11-15時), wn=平日深夜(1-5時), hd=休日昼, hn=休日深夜 [人]\n")
        f.write("  cells: [\n")
        for c in out:
            f.write(f'    {json.dumps(c, ensure_ascii=False)},\n')
        f.write("  ],\n};\n")
    print(f"書き出しました: {OUT_JS}({len(out)} メッシュ)")
    print("index.html を開くと「実データ」モードが選べるようになります。")


if __name__ == "__main__":
    main()
