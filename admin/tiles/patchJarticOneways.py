#!/usr/bin/env python3
"""
JARTIC の一方通行を、OSM の oneway として PBF に足す。

【なぜ要るか】 `lib/jarticOneways.js` の冒頭を読むこと。
入力の一覧（admin/data/jartic-oneways.json）は `buildJarticMopedTurns.js` が作る。

やること:
  1. JARTIC の線を 10m ごとに、いちばん近い平行な道へ当てる
  2. 道の線分ごとに当たった長さを数え、覆われた連なりを一方通行にする
  3. way が途中まで覆われているときは、連なりの端で切る

⚠️ **別の道を一方通行にすると、通れる道が塞がる。** 迷ったら触らない:
   tertiary より大きな道（細い道の線が大通りに当たっても大通りは止めない）
   oneway=no などの登録がある道（登録した人が見ている）
   逆向きの線が同じ道に重なるもの（分離帯のある道を OSM が1本で描いている）
   曲がる規制が使う way の途中まで（切ると relation が壊れる）
⚠️ 歩道も当てる先に入れること。歩道の線を隣の車道と取り違えないため。
⚠️ 同じ向きの一方通行がそばにあれば、線はその道の話。上下線に分かれた道の反対側を裏返さない。

使い方:
  python3 admin/tiles/patchJarticOneways.py in.osm.pbf admin/data/jartic-oneways.json out.osm.pbf

⚠️ **順番: しまなみ → この道具 → patchJarticTurnBans.py。** 曲がる禁止は一方通行を見て組み立てる。
   番号も、足す way がファイルの中で番号順になるよう、こちらを小さくしてある。
"""
import json
import math
import sys
from collections import Counter, defaultdict

import osmium
from osmium.filter import EntityFilter, KeyFilter
import osmium.osm.mutable

from patchJarticTurnBans import CELL, DRIVABLE, Way, bearing, cells_of, diff, meters, restricted_ways, write

MATCH_ROADS = DRIVABLE | {"pedestrian", "track", "path", "footway", "cycleway", "busway", "road"}
CHANGEABLE = {"tertiary", "unclassified", "residential", "living_street", "service"}
SAMPLE_METERS = 10     # 線を見る間隔
NEAR_METERS = 14       # 線と道の許し
SAME_WAY_METERS = 25   # 同じ向きの一方通行を探す範囲（上下線の間隔）
PARALLEL_DEGREES = 35  # 線と道の向きの許し
MIN_LINE_MATCH = 0.5   # 線のこれだけが道に当たらなければ、道の話ではない
MIN_COVER = 0.6        # 線分のこれだけ線が通れば、覆われたとみなす
BOTH_WAYS = 0.3        # 逆向きの線がこれだけ重なれば、両方向の道
MIN_RUN_METERS = 30    # これより短い連なりは触らない
GAP_METERS = 20        # 連なりの間のこれ以下の隙間と、way の端までの余りは埋める
NEW_ID = 2_900_000_000 # 切った way の番号。OSM（約15億）と重ねず、曲がる禁止の 30億より小さく


def read_ways(src, oneways):
    """線のそばを通る道"""
    wanted = set()
    for item in oneways:
        for line in item["lines"]:
            for x, y in cells_of([(0, *p) for p in line]):
                wanted.update((x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1))
    ways = {}
    fp = (osmium.FileProcessor(src).with_locations()
          .with_filter(EntityFilter(osmium.osm.WAY)).with_filter(KeyFilter("highway")))
    for w in fp:
        if w.tags.get("highway") not in MATCH_ROADS or w.tags.get("area") == "yes":
            continue
        nodes = [(n.ref, n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if len(nodes) >= 2 and not wanted.isdisjoint(cells_of(nodes)):
            ways[w.id] = Way(w.id, w.version, {t.k: t.v for t in w.tags}, nodes)
    return ways


def samples(line):
    """線の上の点 → (点, 向き)"""
    for a, b in zip(line, line[1:]):
        length = meters(a, b)
        if length < 0.5:
            continue
        n = max(1, round(length / SAMPLE_METERS))
        heading = bearing(a, b)
        for i in range(n):
            t = (i + 0.5) / n
            yield (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), heading, length / n


def distance_to(q, a, b):
    k = math.cos(math.radians(q[1]))
    ax, ay = (a[0] - q[0]) * k, a[1] - q[1]
    bx, by = (b[0] - q[0]) * k, b[1] - q[1]
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + dx * t, ay + dy * t) * 111320


def match(q, heading, grid):
    """点の話をしている道 → (way, 線分, way の向きに沿うか) / None"""
    x, y = int(q[0] / CELL), int(q[1] / CELL)
    seen, nearest, same = set(), None, None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for way, i in grid.get((x + dx, y + dy), ()):
                if (way.id, i) in seen:
                    continue
                seen.add((way.id, i))
                a, b = way.nodes[i][1:], way.nodes[i + 1][1:]
                if a == b:
                    continue
                gap = abs(diff(bearing(a, b), heading))
                if min(gap, 180 - gap) > PARALLEL_DEGREES:
                    continue
                d = distance_to(q, a, b)
                forward = gap < 90
                if d <= NEAR_METERS and (nearest is None or d < nearest[0]):
                    nearest = (d, way, i, forward)
                if d <= SAME_WAY_METERS and way.oneway == (1 if forward else -1) and (same is None or d < same[0]):
                    same = (d, way, i, forward)
    return (same or nearest or (None,))[1:] or None


def collect_votes(oneways, ways):
    """線分ごとに、線が沿った長さ → {way id: {線分: [順向き, 逆向き]}}, 数え"""
    grid = defaultdict(list)
    for way in ways.values():
        for i in range(len(way.nodes) - 1):
            for c in cells_of(way.nodes[i:i + 2]):
                grid[c].append((way, i))
    votes = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    stats = Counter()
    for item in oneways:
        for line in item["lines"]:
            hits, total = [], 0.0
            for q, heading, length in samples(line):
                total += length
                hit = match(q, heading, grid)
                if hit:
                    hits.append((hit, length))
            matched = sum(length for _, length in hits)
            stats["線の長さ"] += total
            if total == 0 or matched < total * MIN_LINE_MATCH:
                stats["道が見つからない線"] += 1
                continue
            stats["道に当たった線"] += 1
            for (way, i, forward), length in hits:
                votes[way.id][i][0 if forward else 1] += length
    return votes, stats


def runs_of(way, seg_votes):
    """way の覆われた連なり → [(始まりの点, 終わりの点, 向き)]、数え"""
    n = len(way.nodes) - 1
    lengths = [meters(way.nodes[i][1:], way.nodes[i + 1][1:]) for i in range(n)]
    marks = [0] * n
    both = 0.0
    for i, (ahead, back) in seg_votes.items():
        if ahead + back < MIN_COVER * lengths[i]:
            continue
        if min(ahead, back) >= BOTH_WAYS * (ahead + back):
            both += lengths[i]
            continue
        marks[i] = 1 if ahead > back else -1

    # 短い隙間を埋める（10m より短い線分は線の点が落ちないことがある）
    i = 0
    while i < n:
        if marks[i] == 0:
            j = i
            while j < n and marks[j] == 0:
                j += 1
            if 0 < i and j < n and marks[i - 1] == marks[j] and sum(lengths[i:j]) <= GAP_METERS:
                marks[i:j] = [marks[j]] * (j - i)
            i = j
        else:
            i += 1

    runs = []
    i = 0
    while i < n:
        if marks[i] == 0:
            i += 1
            continue
        j = i
        while j < n and marks[j] == marks[i]:
            j += 1
        if sum(lengths[i:j]) >= MIN_RUN_METERS:
            start = 0 if sum(lengths[:i]) <= GAP_METERS and not any(marks[:i]) else i
            end = n if sum(lengths[j:]) <= GAP_METERS and not any(marks[j:]) else j
            runs.append((start, end, marks[i]))
        i = j
    return runs, both


def plan(votes, ways, keep_ids):
    """way ごとの変更 → ({way id: [(始まり, 終わり, 向き)]}, 数え)"""
    changes, stats = {}, Counter()
    for wid, seg_votes in votes.items():
        way = ways[wid]
        runs, both = runs_of(way, seg_votes)
        stats["両方向の線が重なる（m）"] += both
        n = len(way.nodes) - 1
        keep = []
        for start, end, direction in runs:
            length = sum(meters(way.nodes[i][1:], way.nodes[i + 1][1:]) for i in range(start, end))
            whole = start == 0 and end == n
            if way.oneway == direction:
                stats["もう合っている（m）"] += length
            elif way.tags.get("highway") not in CHANGEABLE:
                stats["大きな道・歩道なので見送り（m）"] += length
            elif ("oneway" in way.tags and way.oneway == 0) or "junction" in way.tags \
                    or any(k.startswith("oneway:") for k in way.tags):
                stats["oneway の登録があるので見送り（m）"] += length
            elif way.oneway and not whole:
                stats["逆向きの一部なので見送り（m）"] += length
            elif wid in keep_ids and not whole:
                stats["曲がる規制の way なので見送り（m）"] += length
            else:
                stats["裏返した（m）" if way.oneway else "一方通行にした（m）"] += length
                keep.append((start, end, direction))
        if keep:
            changes[wid] = keep
    return changes, stats


def make_change(changes, ways):
    """way を切って向きを付ける → (書き換える way, 足す way)"""
    modified, created = {}, []
    next_id = NEW_ID
    for wid, runs in changes.items():
        way = ways[wid]
        last = len(way.nodes) - 1
        cuts = sorted({0, last} | {p for start, end, _ in runs for p in (start, end)})
        for a, b in zip(cuts, cuts[1:]):
            tags = dict(way.tags)
            for start, end, direction in runs:
                if start <= a and b <= end:
                    tags["oneway"] = "yes" if direction == 1 else "-1"
            refs = [x[0] for x in way.nodes[a:b + 1]]
            if a == 0:
                modified[wid] = osmium.osm.mutable.Way(id=wid, version=way.version + 1, nodes=refs, tags=tags)
            else:
                next_id += 1
                created.append(osmium.osm.mutable.Way(id=next_id, version=1, nodes=refs,
                                                      tags={**tags, "_orig_way": str(wid)}))
    return modified, created


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    src, list_path, dst = sys.argv[1:]
    with open(list_path, encoding="utf-8") as f:
        oneways = json.load(f)["oneways"]
    ways = read_ways(src, oneways)
    votes, line_stats = collect_votes(oneways, ways)
    changes, stats = plan(votes, ways, restricted_ways(src))
    modified, created = make_change(changes, ways)
    write(src, dst, modified, created, [])
    print(f"一方通行 {len(oneways)}件: {dict(line_stats)}")
    print({k: round(v) for k, v in stats.items()})
    print(f"書き換えた way {len(modified)}本・切って足した way {len(created)}本")
    changed = stats["一方通行にした（m）"] + stats["裏返した（m）"]
    # ⚠️ 大半が食い違うのは線の取り違えの合図。無言で道を塞いだタイルを焼かない
    if changed > (changed + stats["もう合っている（m）"]) * 0.5:
        raise SystemExit("⚠️ 変えた道が5割を超えた。入力か突き合わせを疑うこと")


if __name__ == "__main__":
    main()
