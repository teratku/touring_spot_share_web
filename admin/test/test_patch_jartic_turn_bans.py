#!/usr/bin/env python3
"""
patchJarticTurnBans.py の標識と道の突き合わせ。

  python3 admin/test/test_patch_jartic_turn_bans.py

⚠️ `python3 -I` では動かない（pyosmium はユーザーの site に入っている）。

守りたいのは「許された曲がりまで塞がない」こと。⚠️ 埼玉では道の途中の点で直進を禁じていて、
399本中268本が道を切っていた。ランダムな経路の比較では迂回できてしまい気づけなかった。
"""
import os
import sys
import unittest
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tiles"))
from patchJarticTurnBans import Way, make_change, plan  # noqa: E402

M = 1 / 111320   # 緯度で1m


def road(wid, *points, oneway=False, kind="tertiary"):
    """points: (node 番号, 東へのm, 北へのm)"""
    tags = {"highway": kind}
    if oneway:
        tags["oneway"] = "yes"
    return Way(wid, 1, tags, [(n, 139 + e * M * 1.23, 36 + s * M) for n, e, s in points])


def ways_of(*ways):
    return {w.id: w for w in ways}


def sign(*allowed, at=(0, -10), heading=0):
    return {"at": [139 + at[0] * M * 1.23, 36 + at[1] * M], "inHeading": heading,
            "allowed": list(allowed), "key": "k"}


def kinds(turns):
    return sorted((t[3].id, t[6]) for t in turns)


class CrossroadTest(unittest.TestCase):
    def crossroad(self):
        return ways_of(road(1, (1, 0, -100), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)))

    def test_直進と左折だけなら右折を禁じる(self):
        turns, stats = plan([sign(0, 270)], self.crossroad())
        self.assertEqual(kinds(turns), [(2, "no_right_turn")])
        self.assertEqual(stats["禁止を作れた"], 1)

    def test_左折だけなら直進と右折を禁じる(self):
        turns, _ = plan([sign(270)], self.crossroad())
        self.assertEqual(kinds(turns), [(1, "no_straight_on"), (2, "no_right_turn")])

    def test_全部の向きが許されていれば何も作らない(self):
        turns, stats = plan([sign(0, 90, 270)], self.crossroad())
        self.assertEqual(turns, [])
        self.assertEqual(stats["禁じる出口が無い（すでに合っている）"], 1)

    def test_入ってくる向きが合う道が無ければ作らない(self):
        turns, stats = plan([sign(0, heading=45)], self.crossroad())
        self.assertEqual(turns, [])
        self.assertEqual(stats["入ってくる道が見つからない"], 1)


class KeepRoadOpenTest(unittest.TestCase):
    def test_枝分かれしていない点で直進を禁じない(self):
        ways = ways_of(road(1, (1, 0, -100), (6, 0, -5), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0)))
        turns, _ = plan([sign(270)], ways)
        self.assertEqual([t[0].nodes[t[1]][0] for t in turns], [2], "交差点の点でだけ作る")

    def test_wayの継ぎ目を越えて先の交差点まで行く(self):
        ways = ways_of(road(1, (1, 0, -100), (6, 0, -5)),
                       road(3, (6, 0, -5), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)))
        turns, _ = plan([sign(270)], ways)
        self.assertEqual(kinds(turns), [(2, "no_right_turn"), (3, "no_straight_on")])
        self.assertEqual({t[0].id for t in turns}, {3}, "継ぎ目の先の way を from にする")

    def test_手前の細い道で許された曲がりを塞がない(self):
        # 右折だけの標識。手前の左の小道には右折の出口が無いので、そこで直進を禁じると本物に届かない
        ways = ways_of(road(1, (1, 0, -100), (6, 0, -5), (2, 0, 20), (3, 0, 100)),
                       road(3, (7, -60, -5), (6, 0, -5), kind="residential"),
                       road(2, (2, 0, 20), (5, 100, 20)))
        turns, _ = plan([sign(90)], ways)
        self.assertEqual({t[0].nodes[t[1]][0]: t[6] for t in turns if t[6] == "no_straight_on"},
                         {2: "no_straight_on"})

    def test_合う出口の無い交差点では何も確定しない(self):
        ways = ways_of(road(1, (1, 0, -100), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0)))
        turns, stats = plan([sign(90)], ways)
        self.assertEqual(turns, [])
        self.assertEqual(stats["指定方向に合う交差点が無い"], 1)

    def test_店の出入り口は交差点に数えない(self):
        ways = ways_of(road(1, (1, 0, -100), (6, 0, -5), (2, 0, 0), (3, 0, 100)),
                       road(3, (6, 0, -5), (7, 40, -5), kind="service"),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)))
        turns, _ = plan([sign(0, 270)], ways)
        self.assertEqual(kinds(turns), [(2, "no_right_turn")])


class ReachTest(unittest.TestCase):
    def test_標識が手前に立っていても交差点まで探す(self):
        ways = ways_of(road(1, (1, 0, -200), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)))
        turns, _ = plan([sign(0, 270, at=(0, -70))], ways)
        self.assertEqual(kinds(turns), [(2, "no_right_turn")])

    def test_標識の交差点を過ぎたら先の交差点を見ない(self):
        ways = ways_of(road(1, (1, 0, -100), (2, 0, 0), (6, 0, 60), (3, 0, 200)),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)),
                       road(3, (6, 0, 60), (7, 100, 60)))
        turns, _ = plan([sign(0, 270)], ways)
        self.assertEqual(kinds(turns), [(2, "no_right_turn")])

    def test_中央分離帯の奥の出口まで届く(self):
        # 右の出口は反対車線の点にある（三橋三丁目の形）。左の車線は左へだけ流れる
        ways = ways_of(road(1, (1, 0, -100), (2, 0, 0), (6, 0, 15), (3, 0, 100)),
                       road(2, (4, 100, 0), (2, 0, 0), (5, -100, 0), oneway=True),
                       road(3, (7, -100, 15), (6, 0, 15), (8, 100, 15), oneway=True))
        turns, _ = plan([sign(0, 270)], ways)
        self.assertEqual(kinds(turns), [(3, "no_right_turn")])
        self.assertEqual(turns[0][0].nodes[turns[0][1]][0], 6)


class SplitTest(unittest.TestCase):
    def test_両方向の道はviaで切って片側だけ禁じる(self):
        ways = ways_of(road(1, (1, 0, -100), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)))
        turns, _ = plan([sign(0, 270)], ways)
        modified, created, relations, stats = make_change(turns, set())
        self.assertEqual(stats["relation"], 1)
        self.assertEqual(sorted(modified), [1, 2])
        self.assertEqual(len(created), 2)
        to_way = dict((role, ref) for _, ref, role in relations[0].members)["to"]
        made = next(w for w in created if w.id == to_way)
        self.assertEqual(made.nodes, [2, 5], "東側の切れ端だけが to")

    def test_他の規制のwayは切らずに見送る(self):
        ways = ways_of(road(1, (1, 0, -100), (2, 0, 0), (3, 0, 100)),
                       road(2, (4, -100, 0), (2, 0, 0), (5, 100, 0)))
        turns, _ = plan([sign(0, 270)], ways)
        modified, created, relations, stats = make_change(turns, {2})
        self.assertEqual((relations, stats["見送り（他の規制のway）"]), ([], 1))


if __name__ == "__main__":
    unittest.main()
