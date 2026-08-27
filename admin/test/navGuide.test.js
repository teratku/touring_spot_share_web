"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const g = require("../lib/navGuide");
const { decode6, MANEUVER } = require("../lib/valhallaRoute");

/**
 * アプリと同じ読み上げ文を組み立てるところ。
 *
 * ⚠️ **アプリ側の値をそのまま移してある。** 勝手に変えると、アプリに載せ替えた
 *    ときに違う聞こえ方になり、どちらが正しいのか分からなくなる。
 *    値を動かすなら、先にアプリ側で実機を確かめること。
 */
const FIX = path.join(__dirname, "fixtures-nav.json");
const fixtures = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, "utf8")) : null;
const skipIfNoFixture = (t) => (fixtures ? false : t.skip("材料が無い環境"));

// MARK: 距離の読み

test("「1.0キロ」と言わない", () => {
  // ⚠️ 音声だと「いってんぜろキロ」になって耳障り（アプリの実機指摘）
  for (const meters of [1000, 1020, 1049, 2000, 1950, 3000]) {
    const said = g.spokenDistance(meters);
    assert.ok(!/\.0キロ/.test(said), `${meters}m が「${said}」になっている`);
  }
  assert.strictEqual(g.spokenDistance(1000), "1キロ");
  assert.strictEqual(g.spokenDistance(1950), "2キロ");
  assert.strictEqual(g.spokenDistance(1200), "1.2キロ");
});

test("1km未満は50m単位に丸める", () => {
  // ⚠️「480メートル先」より「500メートル先」が自然（アプリと同じ）
  assert.strictEqual(g.spokenDistance(480), "500メートル");
  assert.strictEqual(g.spokenDistance(320), "300メートル");
  assert.strictEqual(g.spokenDistance(700), "700メートル");
  // ⚠️ 0m や 10m でも「0メートル先」と言わない。最低50m
  assert.strictEqual(g.spokenDistance(0), "50メートル");
  assert.strictEqual(g.spokenDistance(10), "50メートル");
});

// MARK: 何メートル手前で言うか

test("標準の値がアプリと揃っている", () => {
  // ⚠️ **アプリの `NavAnnouncementSettings.standard` と同じであること。**
  //    ここが食い違うと、同じルートでも案内の出るタイミングが変わる
  assert.strictEqual(g.STANDARD.far, 700);
  assert.strictEqual(g.STANDARD.near, 300);
  assert.strictEqual(g.STANDARD.imminent, 60);
  assert.deepStrictEqual(g.activeDistances(), [700, 300, 60]);
  assert.strictEqual(g.imminentThreshold(), 60);
});

test("遠め・近め・直前の順序が逆転していたら直す", () => {
  // ⚠️ 逆転したまま使うと、近めより先に遠めが鳴るなど順序が崩れる
  assert.strictEqual(g.normalized({ far: 300, near: 700, imminent: 60 }).far, 0);
  assert.strictEqual(g.normalized({ far: 700, near: 50, imminent: 60 }).near, 0);
});

test("全部なしにしても、直前だけは残す", () => {
  // ⚠️ **曲がる直前に何も言われないと曲がり損ねる。** アプリと同じ扱い
  const s = g.normalized({ far: 0, near: 0, imminent: 0 });
  assert.strictEqual(s.imminent, g.STANDARD.imminent);
  assert.ok(g.imminentThreshold({ far: 0, near: 0, imminent: 0 }) > 0);
});

test("選べる値は読み上げて自然な数字だけ", () => {
  // ⚠️ 「480メートル手前」のような値を選ばせない（アプリと同じ）
  for (const [key, list] of Object.entries(g.CHOICES)) {
    for (const v of list) {
      assert.ok(v === 0 || v % 10 === 0, `${key} に半端な値 ${v} がある`);
    }
  }
});

// MARK: 文の組み立て

test("交差点名・道路名・操作の順に並ぶ", () => {
  assert.strictEqual(
    g.phrase({ meters: 700, isImminent: false, maneuver: "turnLeft",
               roadName: "明治通り", intersection: "新宿四丁目" }),
    "700メートル先、新宿四丁目交差点を明治通りへ左折です");
  assert.strictEqual(
    g.phrase({ meters: 60, isImminent: true, maneuver: "turnRight",
               intersection: "甲府警察署東" }),
    "まもなく甲府警察署東交差点を右折です");
  // ⚠️ **名前が無いほうが多い**（道路名70.7% / 交差点名38.8%）。無ければ操作だけ
  assert.strictEqual(
    g.phrase({ meters: 300, isImminent: false, maneuver: "turnRight" }),
    "300メートル先、右折です");
});

test("交差点名を付けない操作がある", () => {
  // ⚠️ 「〇〇交差点を合流します」は不自然。アプリの `acceptsIntersectionName` と同じ
  const said = g.phrase({ meters: 1000, isImminent: false, maneuver: "merge",
                          roadName: "関越自動車道", intersection: "〇〇" });
  assert.strictEqual(said, "1キロ先、合流します");
  assert.ok(!said.includes("交差点"), `合流に交差点名が付いている: ${said}`);
  assert.ok(!said.includes("関越自動車道"), `合流に道路名が付いている: ${said}`);
});

test("曲がりくねった道で「直進します」と言わない", () => {
  // ⚠️ Valhalla の straight は「この道を進み続けろ」の意味で、
  //    道がまっすぐという意味ではない。峠で「直進します」は誤解を招く
  const curvy = g.phrase({ meters: 300, isImminent: false, maneuver: "straight",
                           roadName: "道志みち", isCurvyAhead: true });
  const flat = g.phrase({ meters: 300, isImminent: false, maneuver: "straight",
                          roadName: "新青梅街道", isCurvyAhead: false });
  assert.ok(curvy.includes("道なりに進みます"), `曲がりくねりで「${curvy}」`);
  assert.ok(flat.includes("直進します"), `まっすぐな道で「${flat}」`);
});

test("曲がってすぐまた曲がるときは、その次も言う", () => {
  // ⚠️ **走行中は画面を見られない。** 声で言わないと聞き逃す（アプリのコメント）
  const followUp = g.followUpPhrase(180, "turnLeft");
  assert.strictEqual(followUp, "その後200メートル先、左折です");
  const said = g.phrase({ meters: 60, isImminent: true, maneuver: "turnRight",
                          roadName: "青葉通り", followUp });
  assert.strictEqual(said, "まもなく青葉通りへ右折です、その後200メートル先、左折です");
  // 次が無いときは足さない
  assert.strictEqual(g.followUpPhrase(180, "none"), null);
  assert.strictEqual(g.followUpPhrase(0, "turnLeft"), null);
});

test("長い直線では道路名で伝える", () => {
  // ⚠️ 「この道」ではなく名前で言う。同じ道か分岐したか確かめやすい（実機要望）
  assert.strictEqual(g.longStretchPhrase("国道140号", 5000), "国道140号をあと5キロです");
  assert.strictEqual(g.longStretchPhrase(null, 2000), "この道をあと2キロです");
});

// MARK: 操作の対応表

test("Valhalla の全操作に言い回しがある", () => {
  // ⚠️ **抜けがあると、黙って「直進します」と言ってしまう。**
  //    `MANEUVER` に足したのにこちらに足し忘れる、が起きやすい
  const missing = [...new Set(Object.values(MANEUVER))]
    .filter((name) => !(name in g.SPOKEN_PHRASE));
  assert.deepStrictEqual(missing, [],
    `言い回しが無い操作がある: ${missing.join(", ")}`);
});

test("材料に出た操作を、すべて言葉にできる", (t) => {
  if (skipIfNoFixture(t)) return;
  const types = new Set(Object.values(fixtures)
    .flatMap((r) => r.maneuvers).map((m) => m.type));
  for (const type of types) {
    const name = MANEUVER[type];
    assert.ok(name, `Valhalla の type ${type} が対応表に無い`);
    assert.ok(g.SPOKEN_PHRASE[name], `${name} の言い回しが無い`);
  }
});

// MARK: 曲がりくねり

test("峠とまっすぐな道を見分ける", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **しきい値250はアプリの実測から**（幹線100〜165 / 峠600〜900度/km）。
  //    材料の中から「長い」ステップだけを見る。短いステップは曲がり角そのものを
  //    含むので値が跳ね上がり（実測3520度/km）、道の性質を表さない
  const long = [];
  for (const r of Object.values(fixtures)) {
    const pts = decode6(r.shape[0]);
    for (const m of r.maneuvers) {
      if ((m.length || 0) * 1000 < 2000) continue;      // 2km以上のステップだけ
      const slice = pts.slice(m.begin_shape_index, m.end_shape_index + 1);
      long.push({ curviness: g.curvinessDegPerKm(slice),
                  follow: g.shouldSayFollowTheRoad(slice) });
    }
  }
  assert.ok(long.length >= 10, `長いステップが ${long.length} 件しかない（材料が悪い）`);
  const curvy = long.filter((x) => x.follow);
  const flat = long.filter((x) => !x.follow);
  assert.ok(curvy.length > 0, "道なりと判じるステップが1つも無い");
  assert.ok(flat.length > 0, "全部が道なりになっている（しきい値が低すぎる）");
  for (const x of curvy) assert.ok(x.curviness >= g.FOLLOW_THE_ROAD_DEG_PER_KM);
  for (const x of flat) assert.ok(x.curviness < g.FOLLOW_THE_ROAD_DEG_PER_KM);
});

test("しきい値がアプリと揃っている", () => {
  assert.strictEqual(g.FOLLOW_THE_ROAD_DEG_PER_KM, 250);
});

test("点が少なくても落ちない", () => {
  assert.strictEqual(g.curvinessDegPerKm([]), 0);
  assert.strictEqual(g.curvinessDegPerKm([[139, 35]]), 0);
  assert.strictEqual(g.curvinessDegPerKm([[139, 35], [139.1, 35]]), 0);
});
