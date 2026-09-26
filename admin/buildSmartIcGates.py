#!/usr/bin/env python3
"""
admin/buildSmartIcGates.py

**スマートIC（ETC専用）の料金所の位置**を OSM から取り出し、`admin/data/smart-ic-gates.json` に書く。
サーバ（`admin/lib/smartIcGates.js`）が「ETC車載器なし」の乗り手の経路からスマートICを外すのに使う。

【なぜ要るか】
利用者の要望（2026-09-26）: スマートICは ETC 専用。車載器が無いバイクで入ると通れない。
Valhalla は ETC 専用かどうかを知らない（`payment:*` を読まない。OSM でもほぼ付いていない）ので、
**ゲートの位置を自前で持ち、経路が通ったら塞いで引き直す**（`restrictionAvoid.js` と同じ流儀）。

【ゲートの見分け方】実測（2026-09-26・japan.osm.pbf 2026-08-25）
- スマートICの分岐（`highway=motorway_junction` で名前に「スマート」「SIC」）は 327。
- ゲート（`barrier=toll_booth` / `lift_gate`）のうち**名前に「スマート」**があるのは 359。
  ⚠️ **名前だけでは足りない。** 名前の無いゲートが多い（下の「つながり」で 240 増える）。
- **つながり**: 分岐からランプ（motorway_link / trunk_link / service）だけをたどり、
  いちばん近い（道のり）分岐をそのゲートの持ち主にする。持ち主がスマートICならスマートICのゲート。
  ⚠️ **公道に出たらたどらない。** 公道を渡ると隣の普通の IC の料金所まで届く。
  ⚠️ **本線に戻らない。** 本線を渡ると次の IC まで届く。
  ⚠️ **ゲートの名前が普通の IC の名前なら外す。** 亀山IC の料金所は亀山PA/スマートIC から
     道のり290mで届いてしまう（普通の IC とスマートICが絡み合っている）。
- どこからも届かない名前の無いゲートは、1km 以内の分岐がスマートICだけのときに限り入れる（7）。
- ⚠️ **本線の上のゲートは入れない。** 三郷料金所（本線の料金所）はスマートICの分岐から238m。
  塞ぐと常磐道が通れなくなる。

【塞ぐ大きさ】
ゲートを中心にした四角で塞ぐ。⚠️ **本線に触れない大きさにする。** 実測で600か所のうち
39か所が本線から40m以内（いちばん近いのは加計スマートIC 11.8m）。
四角の半分の幅 = min(10m, (本線までの距離 − 2m) ÷ √2)。本線から8m未満のゲートは入れない。

使い方（OSM の焼き直しのたびに作り直す）:
  ~/Documents/OSM道路データ更新/osm-env/bin/python admin/buildSmartIcGates.py \\
      ~/Documents/OSM道路データ更新/valhalla/japan_files/japan.osm.pbf
  （pyosmium が要る。osmium コマンドも使う。4〜5分）

⚠️ 実測の検査は `python3 -m unittest admin/test/test_build_smart_ic_gates.py`（純ロジック）。
"""
import collections
import heapq
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "smart-ic-gates.json")

SMART = re.compile(r"スマート|すマート|SIC|SMART", re.I)
#: たどる道（ランプ・SA/PA の中の道）
LINK = {"motorway_link", "trunk_link", "service"}
#: 公道（ここに出たらたどらない）
PUBLIC = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
          "primary_link", "secondary_link", "tertiary_link"}
#: 分岐からたどる道のりの上限（m）。SA/PA の奥のゲートは 900m ほど
MAX_PATH_METERS = 3000
#: どこからも届かないゲートを、近くの分岐で決めるときの距離（m）
NEAR_JUNCTION_METERS = 1000
#: 塞ぐ四角の半分の幅の上限（m）
MAX_HALF_METERS = 10
#: 本線からこれより近いゲートは入れない（塞ぐと本線に触れる）
MIN_MOTORWAY_METERS = 8


def norm(s):
    """全角を半角にそろえる（「ＳＩＣ」「SＩＣ」も SIC にする）"""
    return unicodedata.normalize("NFKC", s or "")


def is_smart_name(s):
    return bool(SMART.search(norm(s)))


def meters(a, b):
    """(lat, lon) の2点の距離（m）。近い所どうしだけなので平面で足りる"""
    k = math.cos(math.radians(a[0])) * 111320
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * k)


def segment_meters(p, a, b):
    """点 p から線分 ab までの距離（m）"""
    k = math.cos(math.radians(p[0])) * 111320
    ax, ay = (a[1] - p[1]) * k, (a[0] - p[0]) * 111320
    bx, by = (b[1] - p[1]) * k, (b[0] - p[0]) * 111320
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy)


def owners(adj, sources, public, motorway, max_meters=MAX_PATH_METERS):
    """
    分岐（sources: 節点の集まり）からランプだけをたどり、各節点の持ち主（いちばん近い分岐）を返す。
    adj: {節点: [(隣, m), ...]}。⚠️ 公道の節点・本線の節点の先へはたどらない（分岐そのものは除く）
    戻り値: {節点: (道のり m, 分岐)}
    """
    best = {}
    queue = []
    for s in sources:
        if s in adj:
            best[s] = (0.0, s)
            heapq.heappush(queue, (0.0, s, s))
    while queue:
        d, node, src = heapq.heappop(queue)
        if best.get(node, (math.inf,))[0] < d:
            continue
        if node in public and node not in sources:
            continue
        for nxt, w in adj.get(node, ()):
            nd = d + w
            if nd > max_meters:
                continue
            if nxt in motorway and nxt not in sources:
                continue
            if nd < best.get(nxt, (math.inf,))[0]:
                best[nxt] = (nd, src)
                heapq.heappush(queue, (nd, nxt, src))
    return best


def classify(name, on_motorway, owner_name, regular_names, near_junction_names, reached_link):
    """
    そのゲートがスマートICのものか。理由（"name" / "link" / "near"）か None。

    name: ゲートの名前 / owner_name: つながりで決めた持ち主の分岐の名前（届かなければ None）
    regular_names: 普通の IC・JCT の名前の集まり
    near_junction_names: 1km 以内の分岐の名前（近い順）/ reached_link: ランプの上にあるか
    """
    if on_motorway:
        return None                       # ⚠️ 本線の料金所（三郷料金所）を塞がない
    if is_smart_name(name):
        return "name"
    gate_name = norm(name)
    if owner_name is not None:
        if not is_smart_name(owner_name):
            return None
        # ⚠️ 普通の IC の名前のゲートは外す（亀山IC）。名前の無いものは持ち主に従う
        if gate_name and gate_name in regular_names:
            return None
        return "link"
    if gate_name or not reached_link or not near_junction_names:
        return None
    # どこからも届かない名前の無いゲート。1km 以内の分岐がスマートICだけなら入れる
    if all(is_smart_name(n) for n in near_junction_names):
        return "near"
    return None


def box_half(motorway_meters):
    """塞ぐ四角の半分の幅（m）。本線に触れない大きさ。近すぎれば None（入れない）"""
    if motorway_meters < MIN_MOTORWAY_METERS:
        return None
    return round(min(MAX_HALF_METERS, (motorway_meters - 2) / math.sqrt(2)), 1)


def extract(pbf, work):
    """要る物だけの小さい pbf を作る（全国 2.5GB → 0.5GB。pyosmium で読む時間を縮める）"""
    small = os.path.join(work, "smart-ic-src.osm.pbf")
    ways = ",".join(sorted(LINK | PUBLIC | {"motorway"}))
    subprocess.run(["osmium", "tags-filter", pbf,
                    "n/barrier=toll_booth,lift_gate", "n/highway=motorway_junction",
                    f"w/highway={ways}", "-o", small, "--overwrite"], check=True)
    return small


def build(pbf):
    import osmium  # ⚠️ osm-env の Python で動かすこと（pyosmium）

    with tempfile.TemporaryDirectory() as work:
        small = extract(pbf, work)

        gates, junctions = {}, {}

        class Nodes(osmium.SimpleHandler):
            def node(self, n):
                t = n.tags
                barrier = t.get("barrier", "")
                if barrier in ("toll_booth", "lift_gate"):
                    gates[n.id] = dict(lat=n.location.lat, lon=n.location.lon, name=t.get("name", ""))
                if t.get("highway") == "motorway_junction":
                    junctions[n.id] = dict(lat=n.location.lat, lon=n.location.lon, name=norm(t.get("name", "")))

        Nodes().apply_file(small)

        cell = lambda lat, lon: (int(lat * 40), int(lon * 40))       # 約2.5km
        fine = lambda lat, lon: (int(lat * 200), int(lon * 200))     # 約500m
        cells = set()
        for j in junctions.values():
            cy, cx = cell(j["lat"], j["lon"])
            cells.update((cy + dy, cx + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        gate_cells = collections.defaultdict(list)
        for gid, g in gates.items():
            gate_cells[fine(g["lat"], g["lon"])].append(gid)

        adj = collections.defaultdict(list)
        public, motorway, on_link = set(), set(), set()
        mw_meters = {gid: math.inf for gid in gates}

        class Ways(osmium.SimpleHandler):
            def way(self, w):
                hw = w.tags.get("highway", "")
                try:
                    pts = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes]
                except osmium.InvalidLocationError:
                    return
                if len(pts) < 2:
                    return
                if hw == "motorway":
                    motorway.update(p[0] for p in pts)
                    # 本線からゲートまでの距離（塞ぐ大きさを決める）
                    for a, b in zip(pts, pts[1:]):
                        cy, cx = fine(a[1], a[2])
                        for dy in (-1, 0, 1):
                            for dx in (-1, 0, 1):
                                for gid in gate_cells.get((cy + dy, cx + dx), ()):
                                    g = gates[gid]
                                    d = segment_meters((g["lat"], g["lon"]), a[1:], b[1:])
                                    if d < mw_meters[gid]:
                                        mw_meters[gid] = d
                    return
                if not any(cell(p[1], p[2]) in cells for p in (pts[0], pts[len(pts) // 2], pts[-1])):
                    return
                if hw in PUBLIC:
                    public.update(p[0] for p in pts)
                    return
                if hw not in LINK:
                    return
                for p in pts:
                    if p[0] in gates:
                        on_link.add(p[0])
                for a, b in zip(pts, pts[1:]):
                    d = meters(a[1:], b[1:])
                    adj[a[0]].append((b[0], d))
                    adj[b[0]].append((a[0], d))

        Ways().apply_file(small, locations=True, idx="flex_mem")

    owned = owners(adj, set(junctions), public, motorway)
    regular_names = {j["name"] for j in junctions.values() if j["name"] and not is_smart_name(j["name"])}
    j_cells = collections.defaultdict(list)
    for jid, j in junctions.items():
        j_cells[fine(j["lat"], j["lon"])].append(jid)

    def near_junctions(g):
        cy, cx = fine(g["lat"], g["lon"])
        found = []
        for dy in (-2, -1, 0, 1, 2):
            for dx in (-2, -1, 0, 1, 2):
                for jid in j_cells.get((cy + dy, cx + dx), ()):
                    j = junctions[jid]
                    d = meters((g["lat"], g["lon"]), (j["lat"], j["lon"]))
                    if d <= NEAR_JUNCTION_METERS:
                        found.append((d, j["name"]))
        return [n for _, n in sorted(found)]

    out, reasons, too_close = [], collections.Counter(), []
    for gid, g in gates.items():
        own = owned.get(gid)
        owner_name = junctions[own[1]]["name"] if own else None
        near = near_junctions(g) if own is None else []
        why = classify(g["name"], gid in motorway, owner_name, regular_names, near, gid in on_link)
        if not why:
            continue
        half = box_half(mw_meters[gid])
        if half is None:
            too_close.append(norm(g["name"]) or owner_name)
            continue
        ic = norm(g["name"]) if why == "name" else (owner_name or (near[0] if near else ""))
        out.append([round(g["lat"], 6), round(g["lon"], 6), half, ic])
        reasons[why] += 1
    out.sort()
    return out, reasons, too_close, sum(1 for j in junctions.values() if is_smart_name(j["name"]))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pbf = sys.argv[1]
    gates, reasons, too_close, smart_junctions = build(pbf)
    doc = {
        "note": "スマートIC（ETC専用）の料金所。[緯度, 経度, 塞ぐ四角の半分の幅m, IC名]。"
                "作り方は admin/buildSmartIcGates.py",
        "source": os.path.basename(pbf),
        "smartJunctions": smart_junctions,
        "gates": gates,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"スマートICのゲート {len(gates)} か所（{dict(reasons)}）→ {OUT}")
    if too_close:
        print(f"⚠️ 本線に近すぎて入れなかった {len(too_close)} か所: {too_close}")


if __name__ == "__main__":
    main()
