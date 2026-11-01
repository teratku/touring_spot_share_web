#!/usr/bin/env python3
"""
patchJarticOneways.py の線と道の突き合わせ。

  python3 admin/test/test_patch_jartic_oneways.py

⚠️ `python3 -I` では動かない（pyosmium はユーザーの site に入っている）。

守りたいのは「別の道を一方通行にしない」こと。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tiles"))
from patchJarticOneways import MIN_AGREE_METERS, collect_votes, make_change, plan, trusted_oneways  # noqa: E402
from patchJarticTurnBans import Way  # noqa: E402

M = 1 / 111320   # 緯度で1m


def place(e, n):
    return [139 + e * M * 1.23, 36 + n * M]


def road(wid, *points, kind="residential", **tags):
    """points: (node 番号, 東へのm, 北へのm)"""
    return Way(wid, 1, {"highway": kind, **tags}, [(i, *place(e, n)) for i, e, n in points])


def ways_of(*ways):
    return {w.id: w for w in ways}


def line(*points):
    """points: (東へのm, 北へのm)。点の順が進む向き"""
    return {"lines": [[place(e, n) for e, n in points]], "key": "k"}


def changes_of(oneways, ways, keep=()):
    votes, _ = collect_votes(oneways, ways)
    return plan(votes, ways, set(keep))


NORTH = ((1, 0, 0), (2, 0, 200))


class WholeWayTest(unittest.TestCase):
    def test_線の向きが点の順なら順向き(self):
        changes, stats = changes_of([line((0, 0), (0, 200))], ways_of(road(1, *NORTH)))
        self.assertEqual(changes, {1: [(0, 1, 1)]})
        self.assertAlmostEqual(stats["一方通行にした（m）"], 200, delta=2)

    def test_線が逆なら逆向き(self):
        changes, _ = changes_of([line((0, 200), (0, 0))], ways_of(road(1, *NORTH)))
        self.assertEqual(changes, {1: [(0, 1, -1)]})

    def test_地図の線が少しずれていても当たる(self):
        changes, _ = changes_of([line((8, 0), (8, 200))], ways_of(road(1, *NORTH)))
        self.assertEqual(changes, {1: [(0, 1, 1)]})

    def test_もう合っていれば変えない(self):
        changes, stats = changes_of([line((0, 0), (0, 200))], ways_of(road(1, *NORTH, oneway="yes")))
        self.assertEqual(changes, {})
        self.assertAlmostEqual(stats["もう合っている（m）"], 200, delta=2)

    def test_登録と逆なら裏返す(self):
        changes, stats = changes_of([line((0, 200), (0, 0))], ways_of(road(1, *NORTH, oneway="yes")))
        self.assertEqual(changes, {1: [(0, 1, -1)]})
        self.assertAlmostEqual(stats["裏返した（m）"], 200, delta=2)


class LeaveAloneTest(unittest.TestCase):
    def test_大きな道は止めない(self):
        changes, _ = changes_of([line((0, 0), (0, 200))], ways_of(road(1, *NORTH, kind="primary")))
        self.assertEqual(changes, {})

    def test_onewayの登録は尊重する(self):
        for value in ("no", "alternating", "reversible"):
            changes, _ = changes_of([line((0, 0), (0, 200))], ways_of(road(1, *NORTH, oneway=value)))
            self.assertEqual(changes, {}, value)

    def test_二輪の別登録がある道は触らない(self):
        ways = ways_of(road(1, *NORTH, **{"oneway:motorcycle": "no"}))
        self.assertEqual(changes_of([line((0, 0), (0, 200))], ways)[0], {})

    def test_環状交差点は触らない(self):
        ways = ways_of(road(1, *NORTH, junction="roundabout"))
        self.assertEqual(changes_of([line((0, 200), (0, 0))], ways)[0], {})

    def test_逆向きの線が重なる道は両方向のまま(self):
        lines = [line((3, 0), (3, 200)), line((-3, 200), (-3, 0))]
        changes, stats = changes_of(lines, ways_of(road(1, *NORTH)))
        self.assertEqual(changes, {})
        self.assertGreater(stats["両方向の線が重なる（m）"], 150)

    def test_上下線の片方がそばの農道に当たっても両方向のまま(self):
        ways = ways_of(road(1, *NORTH), road(2, (3, 8, 0), (4, 8, 200), kind="track"))
        lines = [line((6, 0), (6, 200)), line((-6, 200), (-6, 0))]
        changes, stats = changes_of(lines, ways)
        self.assertEqual(changes, {})
        self.assertGreater(stats["両方向の線が重なる（m）"], 150)

    def test_歩道の線を隣の車道に当てない(self):
        ways = ways_of(road(1, *NORTH), road(2, (3, 5, 0), (4, 5, 200), kind="footway"))
        self.assertEqual(changes_of([line((5, 0), (5, 200))], ways)[0], {})

    def test_同じ向きの一方通行がそばにあれば反対車線を裏返さない(self):
        ways = ways_of(road(1, (1, 0, 200), (2, 0, 0), oneway="yes"),      # 下り
                       road(2, (3, 12, 0), (4, 12, 200), oneway="yes"))    # 上り
        # 線は下りの近くにあるが、向きは上り
        changes, _ = changes_of([line((3, 0), (3, 200))], ways)
        self.assertEqual(changes, {})

    def test_同じ向きの一方通行がそばにあれば両方向の道にも当てない(self):
        ways = ways_of(road(1, *NORTH), road(2, (3, 12, 0), (4, 12, 200), oneway="yes"))
        self.assertEqual(changes_of([line((3, 0), (3, 200))], ways)[0], {})

    def test_直角の道には当てない(self):
        ways = ways_of(road(1, (1, -100, 0), (2, 100, 0)))
        self.assertEqual(changes_of([line((0, -100), (0, 100))], ways)[0], {})

    def test_大半が道に当たらない線は捨てる(self):
        # 線の 1/4 だけ既存の道に重なる
        ways = ways_of(road(1, (1, 0, 0), (2, 0, 100)))
        votes, stats = collect_votes([line((0, 0), (0, 400))], ways)
        self.assertEqual(dict(votes), {})
        self.assertEqual(stats["道が見つからない線"], 1)

    def test_短すぎる連なりは触らない(self):
        ways = ways_of(road(1, (1, 0, -200), (2, 0, 0), (3, 0, 20), (4, 0, 220)))
        self.assertEqual(changes_of([line((0, 0), (0, 20))], ways)[0], {})


class PartOfWayTest(unittest.TestCase):
    LONG = ((1, 0, 0), (2, 0, 100), (3, 0, 200), (4, 0, 300))

    def test_途中だけなら切る(self):
        ways = ways_of(road(1, *self.LONG))
        changes, _ = changes_of([line((0, 100), (0, 200))], ways)
        self.assertEqual(changes, {1: [(1, 2, 1)]})
        modified, created = make_change(changes, ways)
        self.assertEqual(modified[1].tags.get("oneway"), None)
        self.assertEqual([list(w.nodes) for w in created], [[2, 3], [3, 4]])
        self.assertEqual([w.tags.get("oneway") for w in created], ["yes", None])
        self.assertEqual(created[0].tags["highway"], "residential")

    def test_全部なら切らず番号も変えない(self):
        ways = ways_of(road(1, *self.LONG))
        changes, _ = changes_of([line((0, 0), (0, 300))], ways)
        modified, created = make_change(changes, ways)
        self.assertEqual(created, [])
        self.assertEqual(modified[1].tags["oneway"], "yes")
        self.assertEqual(modified[1].id, 1)

    def test_線の外へは広げない(self):
        ways = ways_of(road(1, *self.LONG))
        changes, _ = changes_of([line((0, 0), (0, 115))], ways)
        self.assertEqual(changes, {1: [(0, 1, 1)]})

    def test_wayの端の短い余りは一緒に一方通行にする(self):
        ways = ways_of(road(1, (1, 0, 0), (2, 0, 200), (3, 0, 210)))
        changes, _ = changes_of([line((0, 0), (0, 200))], ways)
        self.assertEqual(changes, {1: [(0, 2, 1)]})

    def test_点の細かい道の短い線分の隙間を埋める(self):
        ways = ways_of(road(1, (1, 0, 0), (2, 0, 100), (3, 0, 104), (4, 0, 200)))
        changes, _ = changes_of([line((0, 0), (0, 200))], ways)
        self.assertEqual(changes, {1: [(0, 3, 1)]})

    def test_曲がる規制のwayは途中で切らない(self):
        ways = ways_of(road(1, *self.LONG))
        changes, stats = changes_of([line((0, 100), (0, 200))], ways, keep=[1])
        self.assertEqual(changes, {})
        self.assertAlmostEqual(stats["曲がる規制の way なので見送り（m）"], 100, delta=2)

    def test_曲がる規制のwayでも全部なら向きは付けられる(self):
        ways = ways_of(road(1, *self.LONG))
        self.assertEqual(changes_of([line((0, 0), (0, 300))], ways, keep=[1])[0], {1: [(0, 3, 1)]})

    def test_登録と逆の一部は裏返さない(self):
        ways = ways_of(road(1, *self.LONG, oneway="yes"))
        changes, stats = changes_of([line((0, 200), (0, 100))], ways)
        self.assertEqual(changes, {})
        self.assertAlmostEqual(stats["逆向きの一部なので見送り（m）"], 100, delta=2)


class TrustedPrefectureTest(unittest.TestCase):
    LONG = MIN_AGREE_METERS + 1000

    def lines_of(self, prefecture, north, south, x):
        """一方通行に登録した道と、北向きの線 north 本・南向きの線 south 本"""
        items = []
        ways = {}
        for i in range(north + south):
            wid = x + i
            e = wid * 30
            ways[wid] = road(wid, (wid * 2, e, 0), (wid * 2 + 1, e, self.LONG / (north + south)), oneway="yes")
            ends = (e, 0), (e, self.LONG / (north + south))
            items.append({**line(*(ends if i < north else ends[::-1])), "prefecture": prefecture})
        return items, ways

    def test_登録と合う県だけ使う(self):
        good, ways_good = self.lines_of("埼玉県", 100, 1, 1000)
        bad, ways_bad = self.lines_of("東京都", 20, 80, 2000)
        kept, report = trusted_oneways(good + bad, {**ways_good, **ways_bad}, set())
        self.assertEqual(kept, good)
        self.assertTrue(report["埼玉県"][2])
        self.assertFalse(report["東京都"][2])

    def test_登録と重ならない県は確かめられないので使わない(self):
        items = [{**line((0, 0), (0, 200)), "prefecture": "秋田県"}]
        kept, report = trusted_oneways(items, ways_of(road(1, *NORTH, oneway="yes")), set())
        self.assertEqual(kept, [])
        self.assertFalse(report["秋田県"][2])


if __name__ == "__main__":
    unittest.main()
