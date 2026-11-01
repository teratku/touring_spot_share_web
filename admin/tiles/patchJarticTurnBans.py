#!/usr/bin/env python3
"""
JARTIC の「指定方向外進行禁止」を、曲がる規制（OSM の restriction）として PBF に足す。

【なぜ要るか】 `lib/jarticTurnBans.js` の冒頭を読むこと。
入力の一覧（admin/data/jartic-turn-bans.json）は `buildJarticMopedTurns.js` が作る。

やること:
  1. 標識のそばの道を集める
  2. 標識ごとに「入ってくる道」を決め、停止線から道なりに進んで交差点の出口を見る
  3. 指定方向のどれにも合わない出口を no_left_turn / no_right_turn / no_straight_on にする
  4. 切った way と足す relation を混ぜて PBF を書き直す

⚠️ osmium コマンド（Intel 版）はこの Mac で動かないので pyosmium を使う（pip3 install --user osmium）。

⚠️ **枝分かれしていない点で禁止を作らないこと。** 道の途中の点や way の継ぎ目も「直進の出口」に
   見えるので、そこで no_straight_on を作ると交差点の手前で道が切れ、許された曲がりまで通れなくなる。
   埼玉で 399本中268本がこれになった（ランダムな400経路では迂回できて気づけなかった）。
⚠️ **指定方向に合う出口が1本も無い交差点では確定しない**（標識の交差点ではない）。必ず出口が残る。

⚠️ **車線ごとの標識が1本の way に重なる。** 直進専用と左折専用の進入路が手前で合流して描かれていると、
   2枚の標識が同じ way・同じ交差点に当たり、両方を禁じると全部の出口が塞がる（埼玉2か所）。
   どれかの標識が許している出口は禁じない。

⚠️ **両方向の道は via で切ること。** Valhalla は from/to を way の番号で見るので、via が way の
   途中だと「その way の両側」が一度に禁止になる（右折だけ禁止のつもりが左折も塞ぐ）。
   切った way は新しい番号にする。⚠️ 他の曲がる規制が使っている way は切らず、その出口を見送る。

使い方:
  python3 admin/tiles/patchJarticTurnBans.py in.osm.pbf admin/data/jartic-turn-bans.json out.osm.pbf

⚠️ 焼く場所に pbf を2本置かないこと（docs/valhalla-plan.md）。しまなみの patch と重ねるときは、
   しまなみを当てた PBF を入力にする。
"""
import json
import math
import sys
from collections import Counter, defaultdict

import osmium
from osmium.filter import EntityFilter, KeyFilter, TagFilter
import osmium.osm.mutable

DRIVABLE = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
            "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
            "living_street", "service"}
CELL = 0.0005          # 約50m
FIND_METERS = 30       # 標識から入ってくる道までの許し
AHEAD_METERS = 35      # 停止線から見る範囲（広い交差点・中央分離帯の奥の点まで届く長さ）
FAR_METERS = 100       # 上の範囲に標識の交差点が無いとき探す限り（標識が手前に立っていることがある）
IN_TOLERANCE = 35      # 入ってくる向きの許し（度）
ALLOWED_TOLERANCE = 40 # 指定方向に合うとみなす差（度）
STRAIGHT_DEGREES = 30  # これ未満は直進
UTURN_DEGREES = 150    # これを超える出口は見ない（来た道・反対車線）
SAMPLE_METERS = 15     # 向きは交点から少し離れた点で測る（交点の際の曲がりに騙されない）
NEW_ID = 3_000_000_000 # 切った way・足した relation の番号。OSM の番号（約15億）と重ねない


def meters(a, b):
    dy = (b[1] - a[1]) * 111320
    dx = (b[0] - a[0]) * 111320 * math.cos(math.radians(a[1]))
    return math.hypot(dx, dy)


def bearing(a, b):
    la, lb = math.radians(a[1]), math.radians(b[1])
    d = math.radians(b[0] - a[0])
    y = math.sin(d) * math.cos(lb)
    x = math.cos(la) * math.sin(lb) - math.sin(la) * math.cos(lb) * math.cos(d)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def diff(a, b):
    """向きの差 -180〜180（b から見た a。右が正）"""
    return (a - b + 540) % 360 - 180


def oneway_of(tags):
    v = tags.get("oneway", "")
    if v in ("yes", "1", "true"):
        return 1
    if v in ("-1", "reverse"):
        return -1
    if v == "no":
        return 0
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    if tags.get("highway") in ("motorway", "motorway_link"):
        return 1
    return 0


class Way:
    __slots__ = ("id", "version", "tags", "nodes", "oneway")

    def __init__(self, wid, version, tags, nodes):
        self.id, self.version, self.tags, self.nodes = wid, version, tags, nodes
        self.oneway = oneway_of(tags)

    def steps(self, i, step):
        """i から step 向きに SAMPLE_METERS 離れた点"""
        here = self.nodes[i][1:]
        j = i
        while 0 <= j + step < len(self.nodes):
            j += step
            if meters(here, self.nodes[j][1:]) >= SAMPLE_METERS:
                break
        return self.nodes[j][1:]


def cells_of(nodes):
    """道が通る升目。⚠️ 点だけ見ると、点の少ない長い直線の途中にある標識を取りこぼす"""
    cells = set()
    for p, q in zip(nodes, nodes[1:]):
        n = int(max(abs(q[1] - p[1]), abs(q[2] - p[2])) / CELL) + 1
        for k in range(n + 1):
            cells.add((int((p[1] + (q[1] - p[1]) * k / n) / CELL), int((p[2] + (q[2] - p[2]) * k / n) / CELL)))
    return cells


def read_ways(src, bans):
    """標識のそばを通る、車の走れる道。"""
    cells = set()
    reach = int((FIND_METERS + AHEAD_METERS) / 45) + 1
    for b in bans:
        c = (int(b["at"][0] / CELL), int(b["at"][1] / CELL))
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                cells.add((c[0] + dx, c[1] + dy))
    ways = {}
    fp = (osmium.FileProcessor(src).with_locations()
          .with_filter(EntityFilter(osmium.osm.WAY)).with_filter(KeyFilter("highway")))
    for w in fp:
        if w.tags.get("highway") not in DRIVABLE or w.tags.get("area") == "yes":
            continue
        nodes = [(n.ref, n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if not cells.isdisjoint(cells_of(nodes)):
            ways[w.id] = Way(w.id, w.version, {t.k: t.v for t in w.tags}, nodes)
    return ways


def restricted_ways(src):
    """いまの曲がる規制が使っている way（切ると番号がずれるので切らない）"""
    used = set()
    for r in osmium.FileProcessor(src, osmium.osm.RELATION).with_filter(TagFilter(("type", "restriction"))):
        used.update(m.ref for m in r.members if m.type == "w")
    return used


def nearest_on_way(way, at, heading):
    """入ってくる向きに合う線分のうち、標識に最も近いもの → (距離, 線分番号, 進む向き)"""
    best = None
    for i in range(len(way.nodes) - 1):
        a, b = way.nodes[i][1:], way.nodes[i + 1][1:]
        if meters(a, b) < 0.5:
            continue
        for step, p, q in ((1, a, b), (-1, b, a)):
            if (step == 1 and way.oneway == -1) or (step == -1 and way.oneway == 1):
                continue
            if abs(diff(bearing(p, q), heading)) > IN_TOLERANCE:
                continue
            # 線分への距離（平面で十分）
            k = math.cos(math.radians(at[1]))
            ax, ay = (p[0] - at[0]) * k, p[1] - at[1]
            bx, by = (q[0] - at[0]) * k, q[1] - at[1]
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
            d = math.hypot(ax + dx * t, ay + dy * t) * 111320
            if best is None or d < best[0]:
                best = (d, i, step)
    return best


def exits_at(by_node, node_id, come_way, come_index, come_step):
    """node から出られる腕（来た道の戻りを除く）→ [(way, 交点の添字, 向き, 出る向きの方位)]"""
    out = []
    for way, i in by_node.get(node_id, ()):
        for step in (1, -1):
            if not 0 <= i + step < len(way.nodes):
                continue
            if (step == 1 and way.oneway == -1) or (step == -1 and way.oneway == 1):
                continue
            if way is come_way and i == come_index and step == -come_step:
                continue
            out.append((way, i, step, bearing(way.nodes[i][1:], way.steps(i, step))))
    return out


def exits_ahead(by_node, way, i, step):
    """この点から先へ進める出口 → [(way, 交点の添字, 向き, 曲がる角度, 出る向きの方位)]

    ⚠️ 店などの出入り口（service）は交差点に数えない。標識は出入り口の話をしていない。
    """
    node = way.nodes[i]
    come = bearing(way.steps(i, -step), node[1:])
    out = []
    for to, j, s, heading in exits_at(by_node, node[0], way, i, step):
        turn = diff(heading, come)
        if abs(turn) > UTURN_DEGREES:
            continue
        if to.tags.get("highway") == "service" and way.tags.get("highway") != "service":
            continue
        out.append((to, j, s, turn, heading))
    return out


def exit_key(way, i, step, to, j, s):
    return way.id, i, step, to.id, j, s


def follow(ban, by_node, way, i, step):
    """停止線から道なりに進み、禁じる出口を集める
    → ([(way, 添字, 向き, to, 添字, 向き, 種類)], 交差点が合ったか, 許す出口の鍵)"""
    prev, walked = ban["at"], 0.0
    made, pending, matched, opened = [], [], False, set()

    def is_allowed(e):
        return any(abs(diff(e[4], a)) <= ALLOWED_TOLERANCE for a in ban["allowed"])

    def turn_of(here, e):
        kind = "no_straight_on" if abs(e[3]) < STRAIGHT_DEGREES else (
            "no_right_turn" if e[3] > 0 else "no_left_turn")
        return (*here, e[0], e[1], e[2], kind)

    while 0 <= i < len(way.nodes):
        node = way.nodes[i]
        walked += meters(prev, node[1:])
        prev = node[1:]
        if walked > (AHEAD_METERS if matched else FAR_METERS):
            break
        exits = exits_ahead(by_node, way, i, step)
        if not exits:
            break
        ahead = min((e for e in exits if abs(e[3]) < STRAIGHT_DEGREES), key=lambda e: abs(e[3]), default=None)
        if len(exits) == 1:
            ahead = exits[0]      # 枝分かれしていない。道なりに進むだけ
        else:
            here = (way, i, step)
            pending += [turn_of(here, e) for e in exits if not is_allowed(e) and e is not ahead]
            if any(is_allowed(e) for e in exits):
                matched = True
                opened |= {exit_key(way, i, step, e[0], e[1], e[2]) for e in exits if is_allowed(e)}
                stop = ahead is None or not is_allowed(ahead)
                if ahead is not None and stop:
                    pending.append(turn_of(here, ahead))
                made += pending
                pending = []
                if stop:
                    break
            elif ahead is None:
                break             # 指定方向の無い突き当たり。標識の交差点を見失った
        way, i, step = ahead[0], ahead[1] + ahead[2], ahead[2]
    return made, matched, opened


def plan(bans, ways):
    """標識ごとの禁止を組み立てる → ([(from way, 添字, 向き, to way, 添字, 向き, 種類, 標識)], 数え)"""
    by_node = defaultdict(list)
    for way in ways.values():
        for i, n in enumerate(way.nodes):
            by_node[n[0]].append((way, i))
    grid = defaultdict(list)
    for way in ways.values():
        for c in cells_of(way.nodes):
            grid[c].append(way)

    found_all, opened = [], set()
    stats = Counter()
    for ban in bans:
        at, heading = ban["at"], ban["inHeading"]
        c = (int(at[0] / CELL), int(at[1] / CELL))
        near = {w.id: w for dx in (-1, 0, 1) for dy in (-1, 0, 1) for w in grid.get((c[0] + dx, c[1] + dy), ())}
        found = None
        for way in near.values():
            hit = nearest_on_way(way, at, heading)
            if hit and hit[0] <= FIND_METERS and (found is None or hit[0] < found[0]):
                found = (hit[0], way, hit[1], hit[2])
        if not found:
            stats["入ってくる道が見つからない"] += 1
            continue
        _, way, seg, step = found
        made, matched, allowed = follow(ban, by_node, way, seg + 1 if step == 1 else seg, step)
        found_all.append((ban, made, matched))
        opened |= allowed

    turns = []
    for ban, made, matched in found_all:
        kept = [t for t in made if exit_key(*t[:6]) not in opened]
        turns += [(*t, ban["key"]) for t in kept]
        if kept:
            stats["禁止を作れた"] += 1
        elif made:
            stats["別の車線の標識が許している"] += 1
        else:
            stats["禁じる出口が無い（すでに合っている）" if matched else "指定方向に合う交差点が無い"] += 1
    return turns, stats


def make_change(turns, keep_ids):
    """way を切り、足す relation を組む → (書き換える way, 足す way, 足す relation, 数え)"""
    cuts = defaultdict(set)   # way id → 切る添字
    usable = []
    skipped = 0
    for t in turns:
        way, i, step, to, j, s, kind, key = t
        need = []
        if not way.oneway and 0 < i < len(way.nodes) - 1:
            need.append((way, i))
        if not to.oneway and 0 < j < len(to.nodes) - 1:
            need.append((to, j))
        if way is to and 0 < i < len(way.nodes) - 1:
            need.append((way, i))     # 直進の禁止は from と to を別の番号にしないと書けない
        if any(w.id in keep_ids for w, _ in need):
            skipped += 1
            continue
        for w, k in need:
            cuts[w.id].add(k)
        usable.append(t)

    next_id = NEW_ID
    pieces = {}               # way id → [(始まりの添字, 新しい番号)]
    by_id = {}
    for t in usable:
        by_id[t[0].id], by_id[t[3].id] = t[0], t[3]
    modified, created = {}, []
    for wid, marks in cuts.items():
        way = by_id[wid]
        starts = [0] + sorted(marks)
        pieces[wid] = []
        for n, start in enumerate(starts):
            end = starts[n + 1] if n + 1 < len(starts) else len(way.nodes) - 1
            refs = [x[0] for x in way.nodes[start:end + 1]]
            if n == 0:
                modified[wid] = osmium.osm.mutable.Way(id=wid, version=way.version + 1, nodes=refs,
                                                       tags=way.tags)
                pieces[wid].append((start, wid))
            else:
                next_id += 1
                created.append(osmium.osm.mutable.Way(id=next_id, version=1, nodes=refs,
                                                      tags={**way.tags, "_orig_way": str(wid)}))
                pieces[wid].append((start, next_id))

    def piece(way, seg_start):
        """線分 seg_start〜seg_start+1 を含む切れ端の番号"""
        chosen = way.id
        for start, wid in pieces.get(way.id, ()):
            if start <= seg_start:
                chosen = wid
        return chosen

    relations, seen = [], set()
    for way, i, step, to, j, s, kind, key in usable:
        via = way.nodes[i][0]
        from_id = piece(way, i - 1 if step == 1 else i)
        to_id = piece(to, j if s == 1 else j - 1)
        if (from_id, via, to_id) in seen or from_id == to_id:
            continue
        seen.add((from_id, via, to_id))
        next_id += 1
        relations.append(osmium.osm.mutable.Relation(
            id=next_id, version=1,
            members=[("w", from_id, "from"), ("n", via, "via"), ("w", to_id, "to")],
            tags={"type": "restriction", "restriction": kind, "source": "JARTIC", "_jartic": key}))
    return modified, created, relations, {"relation": len(relations), "切ったway": len(cuts),
                                          "見送り（他の規制のway）": skipped}


def write(src, dst, modified, created, relations):
    """⚠️ PBF は nodes→ways→relations の順。足す way は relation の前に、番号順の末尾へ置く"""
    wrote_ways = False
    with osmium.SimpleWriter(dst, overwrite=True) as out:
        for o in osmium.FileProcessor(src):
            if o.is_relation() and not wrote_ways:
                for w in created:
                    out.add_way(w)
                wrote_ways = True
            if o.is_way() and o.id in modified:
                out.add_way(modified[o.id])
            else:
                out.add(o)
        if not wrote_ways:
            for w in created:
                out.add_way(w)
        for r in relations:
            out.add_relation(r)


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    src, bans_path, dst = sys.argv[1:]
    with open(bans_path, encoding="utf-8") as f:
        bans = json.load(f)["bans"]
    ways = read_ways(src, bans)
    turns, stats = plan(bans, ways)
    modified, created, relations, written = make_change(turns, restricted_ways(src))
    write(src, dst, modified, created, relations)
    print(f"標識 {len(bans)}件: {dict(stats)}")
    print(f"出口 {len(turns)}本 → {written}")
    # ⚠️ 大半が作れないのは way の取り違えの合図。無言で薄いタイルを焼かない
    if stats["禁止を作れた"] < len(bans) * 0.4:
        raise SystemExit("⚠️ 作れた標識が4割未満。入力か突き合わせを疑うこと")


if __name__ == "__main__":
    main()
