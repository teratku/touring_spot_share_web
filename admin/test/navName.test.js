"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  spokenRoadName, intersectionName, spokenIntersection, hasJapanese, stripRomajiParens,
} = require("../lib/navName");

/**
 * Valhalla の maneuver から、読み上げに使う名前を取り出すところ。
 *
 * ⚠️ **材料は手で作らない。** 実際に Valhalla が返した経路をそのまま置いてある
 *    （`fixtures-nav.json` / 7区間・指示141件・うち曲がる116件）。
 *    手作りの材料では、壊しても落ちないテストになる（このセッションで3回やった）。
 */
const FIX = path.join(__dirname, "fixtures-nav.json");
const fixtures = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, "utf8")) : null;
const skipIfNoFixture = (t) => (fixtures ? false : t.skip("材料が無い環境"));

/** 曲がる指示（Valhalla の maneuver type） */
const TURN_TYPES = [9, 10, 11, 12, 13, 14, 15, 16, 17];
const turnManeuvers = () => allManeuvers()
  .filter((m) => TURN_TYPES.includes(m.type));

/**
 * すべての指示。
 * ⚠️ **名前の取り出しは曲がる指示だけの話ではない。** 分岐・ランプ・直進にも
 *    同じ「〜を」の言い回しが出る（実測: 「分岐を左方向です」「1を…」）。
 *    曲がる指示だけを見ていたため、一般名詞の除けと道路名の照合を
 *    外しても落ちないテストになっていた（実際にそうなった）。
 */
const allManeuvers = () => Object.values(fixtures || {}).flatMap((r) => r.maneuvers);

// MARK: 道路名

test("曲がった先の道の名前が取れる", (t) => {
  if (skipIfNoFixture(t)) return;
  const turns = turnManeuvers();
  const got = turns.filter(spokenRoadName).length;
  const ratio = got / turns.length;
  // ⚠️ アプリは Google の文面から74.3%。実測でこちらは70.7%
  assert.ok(ratio > 0.65,
    `道路名が ${(ratio * 100).toFixed(1)}% しか取れない（実測は70.7%）`);
});

test("番号だけ・ローマ字は読み上げない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **`Ōtsudōri` を弾けること。** ASCII だけで判定すると長音符付きの
  //    ローマ字が漏れる。「大津通」を選ぶこと
  for (const m of turnManeuvers()) {
    const name = spokenRoadName(m);
    if (!name) continue;
    assert.ok(hasJapanese(name), `漢字かなを含まない名前を選んでいる: ${name}`);
    assert.ok(!/^[0-9]+$/.test(name), `番号だけを選んでいる: ${name}`);
  }
});

test("曲がる地点の名前を、通し名より先に採る", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **これが `begin_street_names` を先に見る理由。**
  //    `street_names` だけだと番号しか残らない指示がある。
  //    実測: street だけ 59.5% → begin→street で 70.7%
  const onlyNumbered = turnManeuvers().filter((m) => {
    const street = (m.street_names || []).filter(hasJapanese);
    const begin = (m.begin_street_names || []).filter(hasJapanese);
    return street.length === 0 && begin.length > 0;
  });
  assert.ok(onlyNumbered.length >= 5,
    `材料が悪い（street に和名が無く begin にある指示が ${onlyNumbered.length} 件しかない）`);
  for (const m of onlyNumbered) {
    assert.ok(spokenRoadName(m),
      `begin に名前があるのに取れていない: ${JSON.stringify(m.begin_street_names)}`);
  }
});

// MARK: 交差点名

test("交差点名が取れる", (t) => {
  if (skipIfNoFixture(t)) return;
  const turns = turnManeuvers();
  const names = turns.map(intersectionName).filter(Boolean);
  const ratio = names.length / turns.length;
  // ⚠️ アプリは Google の文面から32.0%。実測でこちらは38.8%
  assert.ok(ratio > 0.3,
    `交差点名が ${(ratio * 100).toFixed(1)}% しか取れない（実測は38.8%）`);
  // 実際に出た名前が入っていること（材料が入れ替わったら気づけるように）
  for (const expected of ["新宿四丁目", "甲府警察署東", "野火止下"]) {
    assert.ok(names.includes(expected), `${expected} が取れていない`);
  }
});

test("道路名を交差点名と間違えない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **同じ「〜を」の言い回しが道路名にも使われる。**
  //    「甲州街道を東方向です」の甲州街道は入る道であって曲がる場所ではない
  for (const m of allManeuvers()) {
    const name = intersectionName(m);
    if (!name) continue;
    const roads = [...(m.street_names || []), ...(m.begin_street_names || [])];
    for (const road of roads) {
      assert.ok(!(name === road || name.includes(road) || road.includes(name)),
        `道路名「${road}」を交差点名として拾っている（${JSON.stringify(roads)}）`);
    }
  }
});

test("一般名詞を交差点名にしない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **実測で拾った。**「分岐を直進です」から `分岐` を取ってしまい、
  //    「分岐交差点を直進です」と言うことになる
  const names = allManeuvers().map(intersectionName).filter(Boolean);
  for (const generic of ["分岐", "出口", "入口", "ランプ", "料金所"]) {
    assert.ok(!names.includes(generic), `一般名詞「${generic}」を交差点名にしている`);
  }
});

test("材料に、除けが働く形が入っている", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **上の2つが空振りしていないことを確かめる。** 実測では
  //    どちらも**曲がらない指示**にしか出ない（分岐 type18/19/23/24、
  //    道路名一致 type8）。曲がる指示だけを見ていたときは、
  //    除けを外しても落ちなかった
  const mans = allManeuvers();
  const generic = mans.filter((m) =>
    /^分岐を/.test(m.verbal_transition_alert_instruction || ""));
  assert.ok(generic.length >= 3,
    `材料に「分岐を〜」が ${generic.length} 件しかない。一般名詞の除けを確かめられていない`);

  const sameAsRoad = mans.filter((m) => {
    const alert = m.verbal_transition_alert_instruction || "";
    const at = alert.indexOf("を");
    if (at <= 0) return false;
    const head = alert.slice(0, at).trim();
    return [...(m.street_names || []), ...(m.begin_street_names || [])]
      .some((r) => r && (head === r || head.includes(r) || r.includes(head)));
  });
  assert.ok(sameAsRoad.length >= 2,
    `材料に「道路名と同じ」形が ${sameAsRoad.length} 件しかない。照合を確かめられていない`);
});

test("包含関係でも道路名と見なす", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **完全一致だけでは足りない。** 実測に「E84」と
  //    roads=["E84","1","西湘バイパス",...] の組があり、完全一致でも拾える。
  //    包含が要る形は手で作って確かめる（実測では完全一致で足りていた）
  assert.strictEqual(intersectionName({
    verbal_transition_alert_instruction: "玉川通りを右方向です。",
    street_names: ["246", "246/玉川通り"],
  }), null, "道路名を含む名前を交差点名にしている");
});

// MARK: 読み上げの形

test("すでに「交差点」が付いている名前に、二重で付けない", () => {
  // ⚠️ 実測で見つけた形（長竹三差路・子安町五差路）
  assert.strictEqual(spokenIntersection("長竹三差路"), "長竹三差路");
  assert.strictEqual(spokenIntersection("子安町五差路"), "子安町五差路");
  assert.strictEqual(spokenIntersection("〇〇交差点"), "〇〇交差点");
  assert.strictEqual(spokenIntersection("新宿四丁目"), "新宿四丁目交差点");
});

test("名前が無ければ何も返さない", () => {
  assert.strictEqual(spokenRoadName(null), null);
  assert.strictEqual(spokenRoadName({}), null);
  assert.strictEqual(spokenRoadName({ street_names: ["358"] }), null);
  assert.strictEqual(spokenRoadName({ street_names: ["Ōtsudōri"] }), null);
  assert.strictEqual(intersectionName(null), null);
  assert.strictEqual(intersectionName({}), null);
  assert.strictEqual(spokenIntersection(null), null);
});

test("名前の中のローマ字の括弧を落とす", () => {
  // ⚠️ **実測で見つけた形。** OSM の name にローマ字が同居していることがある。
  //    そのまま読ませると「ちゅうおうどおり しーえいちユーオー…」になる
  assert.strictEqual(stripRomajiParens("中央通り (Chuo-dori)"), "中央通り");
  assert.strictEqual(stripRomajiParens("甲州街道 (Koshu Kaido)"), "甲州街道");
  assert.strictEqual(spokenRoadName({ street_names: ["中央通り (Chuo-dori)"] }), "中央通り");
});

test("漢字かなの括弧は残す", () => {
  // ⚠️ **落とすと別の場所を指す。**「狭山日高ＩＣ（西）」の「（西）」は名前の一部
  assert.strictEqual(stripRomajiParens("狭山日高ＩＣ（西）"), "狭山日高ＩＣ（西）");
  assert.strictEqual(stripRomajiParens("〇〇（南）"), "〇〇（南）");
  assert.strictEqual(stripRomajiParens("明治通り"), "明治通り");
});

test("材料にローマ字混じりの名前が入っている", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ 上の2つが空振りしないこと
  const mixed = allManeuvers().flatMap((m) => [...(m.street_names || []),
                                               ...(m.begin_street_names || [])])
    .filter((n) => typeof n === "string" && hasJapanese(n) && /[（(]/.test(n));
  assert.ok(mixed.length >= 1,
    "材料に括弧つきの名前が無い。ローマ字の除けを確かめられていない");
});
