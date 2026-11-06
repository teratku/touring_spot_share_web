#!/usr/bin/env python3
"""
admin/buildUnknownSpots.py

「アプリにとって未知のスポット」の候補を OSM から抜き出し、`admin/data/unknown-spots.json` に置く。
定義はアプリの repo の docs/unknown-spots-definition.md（利用者の判断 2026-11-06: B を本命・A も一緒・通り過ぎたは未知のまま）。

ここでは OSM だけで決まるもの（種類・名前・wikidata・文化財・立入・車の通れる道の近さ）を付けて書き出す。
アプリの投稿と比べる・おすすめ道路の近さを見る・足切りは、調整ツール（lib/unknownSpots.js）が開くたびにする
（投稿は毎日増えるので、ここに焼き込まない）。

使い方（OSM を焼き直したら作り直す。日本全体で約20分・メモリ約9GB）:
    python3 -B admin/buildUnknownSpots.py ~/Downloads/japan-260823.osm.pbf admin/data/unknown-spots.json

⚠️ osmium の CLI はこの Mac では動かない（Bad CPU type）。pyosmium を使う
⚠️ 書き出すのは定義の表で「入れる」種類だけ。山頂は数だけ（バイクで頂上へ行けない山が大半）
"""
import json
import math
import sys
import collections
from datetime import datetime, timezone

import osmium

#: 車の通れる道。⚠️ 高速道路は寄れないので入れない。track・path・footway は入れない（定義「バイクで行ける」）
DRIVABLE = {
    "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
}
#: 車の通れる道の升目（約 220m）。候補の升目と隣の升目に道があれば「道から 300m 前後」とみなす
ROAD_CELL = 0.002
#: 広い地物（湖・海岸・公園・ダム）は、形の大きさ（外接の半径）を持たせる
WIDE_KINDS = {"lake", "beach", "park", "dam", "camp"}


def kind_of(t):
    g = t.get
    if g("tourism") == "viewpoint": return "viewpoint"
    if g("waterway") == "waterfall" or g("natural") == "waterfall": return "waterfall"
    if g("mountain_pass") == "yes" or g("natural") == "saddle": return "pass"
    if g("natural") == "cape": return "cape"
    if g("natural") == "beach": return "beach"
    if g("amenity") == "public_bath" or g("bath:type") == "onsen" or g("natural") == "hot_spring": return "onsen"
    if g("historic") in ("castle", "ruins", "monument", "memorial", "archaeological_site"): return "historic"
    if g("amenity") == "place_of_worship": return "worship"
    if g("tourism") == "attraction": return "attraction"
    if g("waterway") == "dam": return "dam"
    if g("natural") == "peak": return "peak"
    if g("tourism") == "camp_site": return "camp"
    if g("natural") == "water" and g("water") in ("lake", "reservoir", "pond"): return "lake"
    if g("leisure") == "park" and g("park:type") != "playground": return "park"
    return None


def cell_key(lat, lng):
    return (int(math.floor(lat / ROAD_CELL)) << 20) ^ (int(math.floor(lng / ROAD_CELL)) & 0xFFFFF)


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.found = []                 # [lat, lng, name, kind, osm, radius, tags]
        self.counts = collections.defaultdict(collections.Counter)
        self.road_cells = set()

    def add(self, t, lat, lng, osm, radius=0, probes=None):
        k = kind_of(t)
        if not k:
            return
        c = self.counts[k]
        c["all"] += 1
        name = t.get("name") or t.get("name:ja")
        if not name:
            return
        c["named"] += 1
        if k == "peak":
            return  # 数だけ
        # 神社・寺・公園は数が多い（名前ありで 6万・7万）。wikidata／文化財のあるものだけ書き出す（定義の足切り）
        if k in ("worship", "park") and not any(key in t for key in ("wikidata", "wikipedia", "heritage")):
            c["dropped"] += 1
            return
        extra = {}
        for key in ("wikidata", "wikipedia", "heritage", "access", "fee", "website"):
            if key in t:
                extra[key] = t.get(key)
        if t.get("historic"):
            extra["historic"] = t.get("historic")
        if t.get("bath:type"):
            extra["bath"] = t.get("bath:type")
        self.found.append([round(lat, 6), round(lng, 6), name, k, osm, int(radius), extra, probes or [(lat, lng)]])

    def node(self, n):
        if n.tags and n.location.valid() and len(n.tags) > 0:
            self.add(n.tags, n.location.lat, n.location.lon, "n%d" % n.id)

    def way(self, w):
        hw = w.tags.get("highway")
        if hw in DRIVABLE and w.tags.get("access") not in ("private", "no"):
            prev = None
            for nd in w.nodes:
                loc = nd.location
                if not loc.valid():
                    prev = None
                    continue
                lat, lng = loc.lat, loc.lon
                self.road_cells.add(cell_key(lat, lng))
                # ⚠️ 点の間が升目より長いと升目が抜ける（山道の長い直線）。間を埋める
                if prev is not None:
                    steps = int(max(abs(lat - prev[0]), abs(lng - prev[1])) / ROAD_CELL)
                    for s in range(1, steps):
                        f = s / steps
                        self.road_cells.add(cell_key(prev[0] + (lat - prev[0]) * f, prev[1] + (lng - prev[1]) * f))
                prev = (lat, lng)
            return
        # 線で描かれた滝・ダム（閉じていない線）は最初の点で
        if w.tags and not w.is_closed() and kind_of(w.tags) in ("waterfall", "dam"):
            try:
                loc = w.nodes[0].location
                if loc.valid():
                    self.add(w.tags, loc.lat, loc.lon, "w%d" % w.id)
            except Exception:
                pass

    def area(self, a):
        if not a.tags or not kind_of(a.tags):
            return
        pts = []
        try:
            for ring in a.outer_rings():
                pts.extend((p.lat, p.lon) for p in ring if p.location.valid())
        except Exception:
            return
        if not pts:
            return
        lat = sum(p[0] for p in pts) / len(pts)
        lng = sum(p[1] for p in pts) / len(pts)
        k = math.cos(math.radians(lat)) * 111320
        radius = max(math.hypot((p[0] - lat) * 111320, (p[1] - lng) * k) for p in pts)
        osm = ("w%d" % a.orig_id()) if a.from_way() else ("r%d" % a.orig_id())
        wide = kind_of(a.tags) in WIDE_KINDS
        # 広い地物は形の端が道に近ければよい（湖の真ん中は道から遠い）。形の点を 16 個まで見る
        step = max(1, len(pts) // 16)
        probes = [(lat, lng)] + (pts[::step] if wide else [])
        self.add(a.tags, lat, lng, osm, radius if wide else 0, probes)


def road_near(cells, lat, lng):
    ci, cj = int(math.floor(lat / ROAD_CELL)), int(math.floor(lng / ROAD_CELL))
    for i in (ci - 1, ci, ci + 1):
        for j in (cj - 1, cj, cj + 1):
            if ((i << 20) ^ (j & 0xFFFFF)) in cells:
                return True
    return False


def main():
    pbf, out = sys.argv[1], sys.argv[2]
    h = Handler()
    h.apply_file(pbf, locations=True, idx="flex_mem")
    spots = []
    for lat, lng, name, k, osm, radius, extra, probes in h.found:
        near = any(road_near(h.road_cells, a, b) for a, b in probes)
        spots.append({"lat": lat, "lng": lng, "name": name, "kind": k, "osm": osm,
                      "r": radius, "road": near, **({"x": extra} if extra else {})})
    data = {
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "source": pbf.split("/")[-1],
        "counts": {k: dict(v) for k, v in h.counts.items()},
        "spots": spots,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("候補 %d 件 → %s" % (len(spots), out))


if __name__ == "__main__":
    main()
