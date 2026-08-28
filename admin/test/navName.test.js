"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  spokenRoadName, intersectionName, spokenIntersection, hasJapanese, stripRomajiParens,
  prefectureRoadWord, isExpresswayName,
} = require("../lib/navName");

/** 実際に生成した経路（県つき）。番号の形を確かめるのに使う */
const ROUTES_FIX = path.join(__dirname, "fixtures-nav-routes.json");
const routes = fs.existsSync(ROUTES_FIX)
  ? JSON.parse(fs.readFileSync(ROUTES_FIX, "utf8")) : null;
const allSteps = () => Object.values(routes || {}).flatMap((r) => r.steps);

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

// MARK: 番号の形（国道◯号線・県道◯号線）

test("路線名を番号の形に直す", (t) => {
  if (!routes) return t.skip("材料が無い環境");
  // ⚠️ **これが今回の要。**「河口湖上九一色線」のような二つの地名をつないだ名前は
  //    耳で追えない。道路標識に出ている番号なら、走りながら確かめられる
  assert.strictEqual(
    spokenRoadName(["河口湖上九一色線", "21"], { prefecture: "山梨県" }),
    "県道21号線");
  assert.strictEqual(
    spokenRoadName(["主要地方道さいたま東村山線", "40"], { prefecture: "埼玉県" }),
    "県道40号線");
  // 実際の経路でも出ていること
  const numbered = allSteps().filter((s) => /号線$/.test(s.spokenRoad || ""));
  assert.ok(numbered.length >= 20,
    `番号の形が ${numbered.length} 件しか出ていない（実測59件）`);
});

test("県ごとに都道・府道・道道・県道を言い分ける", () => {
  // ⚠️ **東京で「県道」と言ってはいけない。** 実測の材料に4種類とも入っている
  assert.strictEqual(prefectureRoadWord("東京都"), "都道");
  assert.strictEqual(prefectureRoadWord("北海道"), "道道");
  assert.strictEqual(prefectureRoadWord("大阪府"), "府道");
  assert.strictEqual(prefectureRoadWord("京都府"), "府道");
  assert.strictEqual(prefectureRoadWord("神奈川県"), "県道");
  // 県が分からないときは直さない（適当に「県道」と言わない）
  assert.strictEqual(prefectureRoadWord(null), null);
  assert.strictEqual(spokenRoadName(["河口湖上九一色線", "21"], {}), "河口湖上九一色線");
});

test("材料に4種類とも入っている", (t) => {
  if (!routes) return t.skip("材料が無い環境");
  // ⚠️ 上のテストが空振りしないこと
  const words = new Set(allSteps().map((s) => (s.spokenRoad || "")
    .match(/^(国道|都道|府道|道道|県道)/)).filter(Boolean).map((m) => m[1]));
  for (const word of ["国道", "都道", "府道", "道道", "県道"]) {
    assert.ok(words.has(word), `材料に「${word}」が出ていない`);
  }
});

test("国道は国道と言う", () => {
  // ⚠️ **国道と路線名は同居しない**（396件の指示で0件）。だから
  //    「〜線＋番号」を都道府県道と見なしてよい
  assert.strictEqual(
    spokenRoadName(["246", "玉川通り", "一般国道246号"], { prefecture: "東京都" }),
    "国道246号線");
  assert.strictEqual(
    spokenRoadName(["4", "一般国道4号"], { prefecture: "東京都" }), "国道4号線");
  // 県の指定が無くても国道は言える
  assert.strictEqual(spokenRoadName(["139", "国道139号"], {}), "国道139号線");
});

test("高速を県道と言わない", () => {
  // ⚠️ **実測で見つけた落とし穴。** 高速の名前も「〜線」で終わる。
  //    そのまま直すと「県道3号線」になり、**まったく別の道を指す**
  for (const [name, ref] of [["首都高速3号渋谷線", "3"],
                             ["阪神高速14号松原線", "14"],
                             ["福岡都市高速2号太宰府線", "2"]]) {
    const said = spokenRoadName([name, ref], { prefecture: "東京都" });
    assert.ok(!/号線$/.test(said) || said === name,
      `高速を番号に直している: ${name} → ${said}`);
  }
  assert.ok(isExpresswayName("首都高速3号渋谷線"));
  assert.ok(!isExpresswayName("河口湖上九一色線"));
});

test("実際の経路で、高速を番号に直していない", (t) => {
  if (!routes) return t.skip("材料が無い環境");
  for (const step of allSteps()) {
    if (!/号線$/.test(step.spokenRoad || "")) continue;
    const raw = (step.roadNames || []).join("／");
    assert.ok(!/高速|自動車道/.test(raw),
      `高速を「${step.spokenRoad}」と言っている（元: ${raw}）`);
  }
});

test("路線名のままにも戻せる", (t) => {
  if (!routes) return t.skip("材料が無い環境");
  // ⚠️ **番号が短いとは限らない**（実測: 全体では読み上げ時間が+5%）。
  //    聞き比べられるように、名前のままにも戻せること
  assert.strictEqual(
    spokenRoadName(["河口湖上九一色線", "21"], { prefecture: "山梨県", style: "name" }),
    "河口湖上九一色線");
  const named = allSteps()
    .map((s) => spokenRoadName(s.roadNames || [], { prefecture: s.prefecture, style: "name" }))
    .filter(Boolean);
  assert.ok(named.some((n) => /線$/.test(n)),
    "名前に戻しても路線名が出てこない（切り替えが効いていない）");
  assert.ok(!named.some((n) => /^(国道|都道|府道|道道|県道)\d+号線$/.test(n)),
    "名前に戻したのに番号の形が混ざっている");
});

test("通称＋番号は、番号に直さない", (t) => {
  if (!routes) return t.skip("材料が無い環境");
  // ⚠️ **番号だけでは国道か県道か分からない。**「〜線」という路線名の形が
  //    都道府県道の目印になっている（国道は「国道◯号」か通称を名乗る）。
  //    ⚠️ **実測の危ない例**: 甲府の「城東通り／411」は **国道411号**。
  //    「〜線」の条件を外すと「県道411号線」と言ってしまう
  assert.strictEqual(
    spokenRoadName(["411", "城東通り"], { prefecture: "山梨県" }), "城東通り");
  assert.strictEqual(
    spokenRoadName(["20", "甲州街道"], { prefecture: "東京都" }), "甲州街道");
  assert.strictEqual(
    spokenRoadName(["明治通り", "305"], { prefecture: "東京都" }), "明治通り");

  // 実際の経路でも、通称が番号に化けていないこと
  for (const step of allSteps()) {
    const names = step.roadNames || [];
    const nickname = names.find((n) => /[぀-ヿ一-鿿]/.test(n) && !/線$/.test(n)
      && !/国道\s*\d+\s*号/.test(n));
    if (!nickname) continue;
    if (names.some((n) => /線$/.test(n))) continue;      // 路線名も持つ道は対象外
    if (names.some((n) => /国道\s*\d+\s*号/.test(n))) continue;
    assert.ok(!/^(都道|府道|道道|県道)\d+号線$/.test(step.spokenRoad || ""),
      `通称しか無いのに「${step.spokenRoad}」と言っている（元: ${names.join("／")}）`);
  }
});
