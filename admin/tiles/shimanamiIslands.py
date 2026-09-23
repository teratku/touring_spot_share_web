#!/usr/bin/env python3
"""
しまなみ海道の6島の輪郭を OSM から取り出し、`admin/lib/shimanamiIslands.json` に書く。
サーバ（valhallaRoute.js の `chainEntry`）が「出発地・目的地がどの島の上か」を決めるのに使う。
船でしか行けない近くの島（生名島・岩城島など）は、すぐ隣の鎖の島の続きとして入れる。

【なぜ輪郭が要るか】
島の上の1点からの近さで決めていたら、橋のそばの端点を隣の島と取り違えた
（実測 2026-09-23: 因島の北端→向島、伯方島の北端→大三島、生口島の東→因島）。
取り違えると、手前の橋を一度渡って引き返す経路になり、採れずに船が残る
（因島の北端→今治で 17.8km の船）。島の点を橋の近くに置いたせいで、
さらに「伯方島の点」が実は大島の上にあった。**輪郭で決めれば取り違えない。**

使い方:
  python3 admin/tiles/shimanamiIslands.py japan.osm.pbf

⚠️ OSM の島（place=island）の輪郭は滅多に変わらない。タイルの焼き直しのたびに
   作り直す必要は無い。道の一覧（shimanami-bike-ways.txt）とは別物
"""
import json
import math
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "lib", "shimanamiIslands.json")
# しまなみの範囲（valhallaRoute.js の SHIMANAMI.bounds より少し広め）
BBOX = "132.90,34.03,133.30,34.45"
# ⚠️ **並びは尾道側→今治側で固定。** valhallaRoute.js の橋の並びと対になっている
ORDER = ["向島", "因島", "生口島", "大三島", "伯方島", "大島"]
# 間引きの幅（m）。島の判定に使うだけなので、この粗さで足りる（6島で頂点約870個）
TOLERANCE_METERS = 60
# ⚠️ **船でしか行けない島は、すぐ隣の鎖の島の続きとみなす**（生名島→因島 0.2km、
#    岩城島→生口島 0.6km、弓削島→因島 0.7km）。本州とみなすと尾道大橋から全部の橋を
#    渡らせてしまい、生名島→今治が 105km（船 7.9km）になった（隣の因島へ渡れば 60km 弱）。
#    これより離れた島は入れない（本州か四国かは valhallaRoute.js が決める）
NEAR_CHAIN_METERS = 1_500
# これより小さい島は入れない（岩礁まで入れると重くなるだけ）
MIN_AREA_KM2 = 0.1


def to_m(p, lat0):
    return (p[0] * 111_320 * math.cos(math.radians(lat0)), p[1] * 111_320)


def simplify(points, tol, lat0):
    """Douglas-Peucker。端点は残す"""
    if len(points) < 3:
        return points
    xy = [to_m(p, lat0) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        far, at = 0.0, None
        for i in range(a + 1, b):
            px, py = xy[i]
            d = (abs(dy * px - dx * py + bx * ay - by * ax) / length) if length else math.hypot(px - ax, py - ay)
            if d > far:
                far, at = d, i
        if at is not None and far > tol:
            keep[at] = True
            stack += [(a, at), (at, b)]
    return [p for p, k in zip(points, keep) if k]


def ring_area(r):
    return abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))) / 2


def area_km2(r):
    lat0 = sum(c[1] for c in r) / len(r)
    k = 111.32 * math.cos(math.radians(lat0))
    return ring_area([[c[0] * k, c[1] * 111.32] for c in r])


def meters(a, b):
    lat = (a[1] + b[1]) / 2
    return math.hypot((b[0] - a[0]) * 111_320 * math.cos(math.radians(lat)), (b[1] - a[1]) * 111_320)


def ring_gap(a, b):
    """2つの輪のいちばん近い頂点どうしの距離（m）。間引いた輪どうしなので粗い"""
    return min(meters(p, q) for p in a for q in b)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    with tempfile.TemporaryDirectory() as work:
        area = os.path.join(work, "area.osm.pbf")
        islands = os.path.join(work, "islands.osm.pbf")
        geojson = os.path.join(work, "islands.geojson")
        subprocess.run(["osmium", "extract", "-b", BBOX, "--overwrite", "-o", area, src], check=True)
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", islands, area, "wr/place=island"], check=True)
        subprocess.run(["osmium", "export", "--overwrite", "--geometry-types=polygon",
                        "-f", "geojson", "-o", geojson, islands], check=True)
        features = json.load(open(geojson, encoding="utf-8"))["features"]

    # ⚠️ **同じ名前の島が他にもある**（因島の沖に小さな「大島」がある）。いちばん大きい輪郭を採る
    best = {}
    rest = []
    for f in features:
        name = f["properties"].get("name") or ""
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            outer = poly[0]
            if name in ORDER:
                if name not in best or ring_area(outer) > ring_area(best[name]):
                    best[name] = outer
            elif name not in ("本州", "四国"):
                rest.append((name, outer))
    missing = [n for n in ORDER if n not in best]
    if missing:
        sys.exit(f"★ 島の輪郭が見つからない: {missing}")

    def thin(ring):
        lat0 = sum(c[1] for c in ring) / len(ring)
        return [[round(c[0], 5), round(c[1], 5)] for c in simplify(ring, TOLERANCE_METERS, lat0)]

    out = {name: thin(best[name]) for name in ORDER}
    candidates = []
    seen = set()
    for name, ring in rest:
        if area_km2(ring) < MIN_AREA_KM2:
            continue
        small = thin(ring)
        key = tuple(map(tuple, small[:3]))
        if key in seen:          # 同じ島が名前つき・名前なしで二重に入っていることがある
            continue
        seen.add(key)
        candidates.append((name, small))
    # 鎖の島のすぐ隣の島から順に、つながりをたどる。
    # ⚠️ **たどらないと、橋で繋がった島の奥が本州扱いになる。** 佐島は因島から 2.0km だが、
    #    生名島・弓削島と橋（ゆめしま海道）で繋がっている。本州扱いだと佐島→今治が 109km
    #    になった（生名島から因島へ渡れば 60km 台）
    # ⚠️ **鎖の島に直接隣り合う島を先に決める。** たどった先より、じかに隣の島を優先する
    #    （一度に比べると、津波島が伯方島 0.7km より、たどった先の島を選んだ）
    others = []
    rings = [(i, out[n]) for i, n in enumerate(ORDER)]
    while True:
        found = []
        for name, small in candidates:
            if any(o["ring"] is small for o in others):
                continue
            gap, near = min((ring_gap(small, r), i) for i, r in rings)
            if gap <= NEAR_CHAIN_METERS:
                found.append({"name": name, "near": near, "ring": small})
        if not found:
            break
        others += found
        rings += [(o["near"], o["ring"]) for o in found]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"_source": "OpenStreetMap place=island（© OpenStreetMap contributors, ODbL）",
                   "_tolerance_meters": TOLERANCE_METERS,
                   "_near_chain_meters": NEAR_CHAIN_METERS,
                   "order": ORDER, "islands": out, "others": others}, f, ensure_ascii=False)
    print("島の輪郭:", {n: len(v) for n, v in out.items()}, "→", os.path.normpath(OUT))
    print("隣の島の続きとみなす島:", [f"{o['name'] or '(名前なし)'}→{ORDER[o['near']]}" for o in others])


if __name__ == "__main__":
    main()
