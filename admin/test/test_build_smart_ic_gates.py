"""
スマートIC（ETC専用）の料金所の見分け方（`admin/buildSmartIcGates.py` の純ロジック）。

動かし方: python3 -m unittest admin/test/test_build_smart_ic_gates.py
（pyosmium は要らない。OSM を読む所は検査しない）
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import buildSmartIcGates as b  # noqa: E402

REGULAR = {"亀山IC", "三郷料金所", "高崎JCT"}


class SmartNameTest(unittest.TestCase):
    def test_スマートICの名前を全角や書き損じも含めて見分ける(self):
        for name in ["福島松川スマートIC (下り)", "綾瀬SIC", "静岡ＳＡ（上り）ＳＩＣ", "太田強戸すマートＩＣ",
                     "田村SＩＣ", "Kuragaike Smart IC"]:
            self.assertTrue(b.is_smart_name(name), name)
        for name in ["亀山IC", "三郷料金所", "", None, "高崎玉村IC"]:
            self.assertFalse(b.is_smart_name(name), name)


class ClassifyTest(unittest.TestCase):
    def test_本線の上の料金所は名前があっても入れない(self):
        # ⚠️ 三郷料金所（本線）はスマートICの分岐から238m。塞ぐと常磐道が通れない
        self.assertIsNone(b.classify("三郷料金所スマートIC", True, "三郷料金所スマートIC", REGULAR, [], True))
        self.assertIsNone(b.classify("", True, "三郷料金所スマートIC", REGULAR, [], True))

    def test_名前にスマートがあれば入れる(self):
        self.assertEqual(b.classify("亀山スマートIC", False, "亀山IC", REGULAR, [], True), "name")
        self.assertEqual(b.classify("綾瀬SIC", False, None, REGULAR, [], False), "name")

    def test_名前の無いゲートはつながった分岐に従う(self):
        self.assertEqual(b.classify("", False, "波志江PA/スマートIC", REGULAR, [], True), "link")
        self.assertIsNone(b.classify("", False, "亀山IC", REGULAR, [], True))

    def test_普通のICの名前のゲートはスマートICから届いても入れない(self):
        # ⚠️ 亀山IC の料金所は亀山PA/スマートIC から道のり290mで届く
        self.assertIsNone(b.classify("亀山IC", False, "亀山PA/スマートIC(上り)", REGULAR, [], True))
        # 高崎玉村スマートIC のゲートは「高崎玉村IC」と書かれているが、普通の高崎玉村IC は無い
        self.assertEqual(b.classify("高崎玉村IC", False, "高崎玉村スマートIC", REGULAR, [], True), "link")

    def test_どこからも届かないゲートは近くの分岐がスマートICだけのときに入れる(self):
        self.assertEqual(b.classify("", False, None, REGULAR, ["胎内SIC"], True), "near")
        self.assertEqual(b.classify("", False, None, REGULAR, ["胎内SIC", "淡路北スマートIC"], True), "near")
        # 普通の IC も近くにあると決められない
        self.assertIsNone(b.classify("", False, None, REGULAR, ["胎内SIC", "亀山IC"], True))
        # 名前のあるもの・ランプの上に無いもの・近くに分岐が無いものは入れない
        self.assertIsNone(b.classify("表関所", False, None, REGULAR, ["胎内SIC"], True))
        self.assertIsNone(b.classify("", False, None, REGULAR, ["胎内SIC"], False))
        self.assertIsNone(b.classify("", False, None, REGULAR, [], True))


class BoxHalfTest(unittest.TestCase):
    def test_塞ぐ四角は本線に触れない大きさ(self):
        # ⚠️ 本線から11.8mのゲートがある（加計スマートIC）。四角の角でも本線に届かない
        self.assertAlmostEqual(b.box_half(11.8), 6.9, places=1)
        self.assertEqual(b.box_half(100), 10)
        self.assertAlmostEqual(b.box_half(8), 4.2, places=1)
        self.assertIsNone(b.box_half(7.9))
        for d in [8, 9.5, 11.8, 15, 25, 40]:
            half = b.box_half(d)
            self.assertLess(half * 2 ** 0.5, d, f"{d}m のとき角が本線に触れる")


class OwnersTest(unittest.TestCase):
    def test_いちばん近い分岐が持ち主で公道と本線の先へはたどらない(self):
        #  J1(スマート) -100- a -100- g1
        #  J2(普通)     -100- b -100- g5 -400- c -400- J1 側（J1 からは 1000m、J2 からは 200m）
        #  g1 -50- p（公道の節点） -50- g3   ← 公道を渡った先
        #  J1 -60- m（本線の節点）  -60- g4   ← 本線を渡った先
        edges = [("J1", "a", 100), ("a", "g1", 100), ("J2", "b", 100), ("b", "g5", 100),
                 ("g5", "c", 400), ("c", "a", 400), ("g1", "p", 50), ("p", "g3", 50),
                 ("J1", "m", 60), ("m", "g4", 60), ("a", "far", 3500),
                 # 先に見つかる遠い道（J1 から 1000m）より、あとで見つかる近い道（J2 から 30m）を採る
                 ("J1", "gx", 1000), ("J2", "y", 10), ("y", "z", 10), ("z", "gx", 10)]
        adj = {}
        for x, y, w in edges:
            adj.setdefault(x, []).append((y, w))
            adj.setdefault(y, []).append((x, w))
        own = b.owners(adj, {"J1", "J2"}, public={"p"}, motorway={"m", "J1", "J2"})
        self.assertEqual(own["g1"], (200, "J1"))
        self.assertEqual(own["g5"][1], "J2", "近いほうの分岐を持ち主にしていない")
        self.assertIn("p", own)                    # 公道の節点までは届く
        self.assertNotIn("g3", own, "公道を渡った先まで届いた（隣の普通の IC の料金所を拾う）")
        self.assertNotIn("g4", own, "本線を渡った先まで届いた（次の IC まで届く）")
        self.assertNotIn("far", own, "上限の道のりを超えて届いた")
        self.assertEqual(own["gx"], (30, "J2"), "先に見つかった遠い分岐を持ち主にした")


if __name__ == "__main__":
    unittest.main()
