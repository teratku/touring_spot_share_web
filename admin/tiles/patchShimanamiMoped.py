#!/usr/bin/env python3
"""
しまなみ海道の自転車の陸路を、原付（125cc以下）にも開けた PBF を作る。

【なぜ要るか】
125cc以下は西瀬戸自動車道（本線）を走れず、橋ごとの原付道・自転車歩行者道を
渡る。ところが OSM ではそれらが highway=path / footway / cycleway で描かれていて、
Valhalla は歩道系の道を motor_scooter に**タグに関係なく使わせない**
（moped=yes が付いていても）。そのままだと原付は四国へ船でしか渡れない。

⚠️ **利用者の判断（2026-09-22）: 自転車の陸路が使う歩道系の道を全部開ける。**
   橋ごとに原付の通り方は違うので、アプリはしまなみを通る経路で
   「入口の標識で確かめてください」と知らせる（iOS の NavSignCheckRoads.swift）。

実測（しまなみだけ切り出して焼いたタイル・尾道→今治・原付・経由地を足して引く）:
    歩道系を付け替えるだけ            引けない
    ＋障害物に moped=yes を足す        75.1km 陸路   ← これを採る
    ＋障害物を外す                    75.1km 陸路（上と同じ経路）
    ＋途切れて見えた89mを繋ぐ          引けない（繋ぎは要らない）

やること:
  1. shimanami-bike-ways.txt の way と、その node を入力から抜き出す（osmium getid -r）
  2. 歩道系の way → highway=unclassified・moped=yes・mofa=yes（元の値は _orig_highway）。
     ⚠️ 同時に motor_vehicle=no・motorcar=no・motorcycle=no を付けて、原付だけに開ける
  3. それらの way の上の障害物（barrier=*）に moped=yes・mofa=yes を足す
     ⚠️ 障害物そのものは外さない。外さなくても通れる（上の実測）
  4. osmChange を書いて osmium apply-changes で当てる

⚠️ **足しても、Valhalla は自由に引くと見つけきれない。** 長い区間の探索では
   細い道を省くため。サーバが橋ごとに経由地を足す（valhallaRoute.js の SHIMANAMI）。

使い方:
  python3 admin/tiles/patchShimanamiMoped.py japan.osm.pbf japan_shimanami.osm.pbf

⚠️ **道の一覧が古くなったら止まる。** OSM の更新で way が消えたり分割されたり
   すると、一覧の way が入力に無くなる。そのときは shimanamiBikeWays.js で作り直す。
"""
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
WAY_LIST = os.path.join(HERE, "shimanami-bike-ways.txt")

# Valhalla が motor_scooter に使わせない道の種類（タグに関係なく）
FOOT_LIKE = {"path", "footway", "cycleway", "pedestrian", "bridleway", "steps"}


def read_way_ids(path):
    with open(path, encoding="utf-8") as f:
        return sorted({int(x) for x in f.read().split() if x.strip()})


def extract(src, way_ids, out_xml):
    """一覧の way と、それが参照する node を XML で抜き出す"""
    ids_file = out_xml + ".ids"
    with open(ids_file, "w", encoding="utf-8") as f:
        f.write("\n".join(f"w{i}" for i in way_ids))
    subprocess.run(["osmium", "getid", "-r", "--overwrite", "-f", "osm",
                    "-i", ids_file, "-o", out_xml, src], check=True)


def tags_of(el):
    return {t.get("k"): t.get("v") for t in el.findall("tag")}


def with_tags(el, tags, bump=True):
    """同じ形の要素を、タグを差し替えて作る。⚠️ version を上げて必ず入力に勝たせる"""
    out = ET.Element(el.tag, dict(el.attrib))
    if bump:
        out.set("version", str(int(el.get("version", "0")) + 1))
    for nd in el.findall("nd"):
        out.append(ET.Element("nd", dict(nd.attrib)))
    for k, v in sorted(tags.items()):
        out.append(ET.Element("tag", {"k": k, "v": v}))
    return out


def build_changes(extract_xml, way_ids):
    root = ET.parse(extract_xml).getroot()
    ways = {int(w.get("id")): w for w in root.findall("way")}
    nodes = {int(n.get("id")): n for n in root.findall("node")}

    missing = [i for i in way_ids if i not in ways]
    if missing:
        sys.exit(f"★ 一覧の way が入力に {len(missing)} 本ありません（例: {missing[:5]}）。"
                 " OSM が更新されて道が変わった合図です。shimanamiBikeWays.js で一覧を作り直してください。")

    changed_ways, changed_nodes = [], []
    on_route = set()
    for wid in way_ids:
        w = ways[wid]
        for nd in w.findall("nd"):
            on_route.add(int(nd.get("ref")))
        t = tags_of(w)
        if t.get("highway") in FOOT_LIKE:
            t["_orig_highway"] = t["highway"]
            t["highway"] = "unclassified"
            # ⚠️ **車と126cc以上には閉じたままにすること。** 歩道系の道では車・バイクが
            #    暗黙に閉じていたが、unclassified では暗黙に開く。付け替えるだけだと
            #    94本のうち32本が車と126cc以上のバイクに、14本が車に開いた
            #    （実測 2026-09-22。大型バイクの経路が歩道を近道に使いかねない）。
            #    ⚠️ 元の値は見ずに上書きする（歩道に motorcycle=yes が付いていても信じない）
            t["motor_vehicle"] = "no"
            t["motorcar"] = "no"
            t["motorcycle"] = "no"
            t["moped"] = "yes"
            t["mofa"] = "yes"
            changed_ways.append(with_tags(w, t))
    for nid in sorted(on_route):
        n = nodes.get(nid)
        if n is None:
            continue
        t = tags_of(n)
        if "barrier" in t:
            t["moped"] = "yes"
            t["mofa"] = "yes"
            changed_nodes.append(with_tags(n, t))

    change = ET.Element("osmChange", {"version": "0.6", "generator": "patchShimanamiMoped.py"})
    modify = ET.SubElement(change, "modify")
    # ⚠️ node → way の順に並べる（osmChange の決まり）
    for el in changed_nodes + changed_ways:
        modify.append(el)
    return change, len(changed_ways), len(changed_nodes)


# 付け替えた道が持っていなければならないタグ（原付だけに開ける）
MOPED_ONLY = {"highway": "unclassified", "motor_vehicle": "no", "motorcar": "no",
              "motorcycle": "no", "moped": "yes", "mofa": "yes"}


def verify(dst, way_ids, expect_ways, work):
    """当たったかを出力から数え直す。⚠️ 終了コード0だけで信じない"""
    check_xml = os.path.join(work, "check.osm")
    extract(dst, way_ids, check_xml)
    root = ET.parse(check_xml).getroot()
    opened = [tags_of(w) for w in root.findall("way") if tags_of(w).get("_orig_highway")]
    if len(opened) != expect_ways:
        sys.exit(f"★ 付け替えが {len(opened)}/{expect_ways} 本しか当たっていません")
    # ⚠️ **車・126cc以上に開いていないこと。** 開くと大型バイクの経路が歩道に乗る
    wrong = [t for t in opened if any(t.get(k) != v for k, v in MOPED_ONLY.items())]
    if wrong:
        sys.exit(f"★ 原付だけに開けられていない道が {len(wrong)} 本あります: {wrong[0]}")
    return len(opened)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    way_ids = read_way_ids(WAY_LIST)
    with tempfile.TemporaryDirectory() as work:
        extract_xml = os.path.join(work, "targets.osm")
        extract(src, way_ids, extract_xml)
        change, n_ways, n_nodes = build_changes(extract_xml, way_ids)
        osc = os.path.join(work, "shimanami.osc")
        ET.ElementTree(change).write(osc, encoding="utf-8", xml_declaration=True)
        subprocess.run(["osmium", "apply-changes", "--overwrite", "-o", dst, src, osc], check=True)
        opened = verify(dst, way_ids, n_ways, work)
    print(f"しまなみ: 自転車の陸路 {len(way_ids)} 本のうち、歩道系 {opened} 本を原付に開けた"
          f"／障害物 {n_nodes} か所に moped=yes → {dst}")


if __name__ == "__main__":
    main()
