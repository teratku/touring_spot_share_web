"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { SHIMANAMI, shimanamiLocations, chainEntry, bridgePasses } = require("../lib/valhallaRoute");

/**
 * しまなみ海道を原付で渡らせるために、**橋ごとの経由地を足す**処理の確認（Valhalla 不要）。
 *
 * ⚠️ ここで守りたいのは次の3つ。どれも実測で起きた。
 *    ・本州↔四国なら、橋を**順に全部**渡らせる（1本でも抜けると、そこで船に回る）
 *    ・島の上が目的地なら、**その島の先の橋は渡らせない**（渡ると行って戻る）
 *    ・どちらから入るかは、**四国の中かどうか**で決める（近さで決めると逆から入る）
 */

const 尾道 = [133.2050, 34.4089];
const 今治 = [132.9977, 34.0663];
const 東京 = [139.767, 35.681];
const 松山 = [132.77, 33.84];
const 広島 = [132.46, 34.39];
const 高松 = [134.0434, 34.3401];
const 土生 = [133.2000, 34.2880];     // 因島の東の端（島の点から 5.8km）
const 宮浦 = [132.99, 34.25];         // 大三島の西（大山祇神社のあたり）
// 船（まんなか・乗る所・降りる所）。⚠️ 形は valhallaRoute.js の ferriesOf と同じ
const 船 = (mid, start = mid, end = mid) => ({ mid, start, end });
const しまなみの船 = 船([133.10, 34.25]);                          // 島どうし（bounds の中）
const 直島高松 = 船([134.01, 34.40], [133.97, 34.46], [134.047, 34.352]); // 本州側の島→四国
const 宇野直島 = 船([133.95, 34.47], [133.93, 34.49], [133.97, 34.46]);  // 本州→本州側の島

const loc = ([lon, lat], type) => (type ? { lon, lat, type } : { lon, lat });
/** 足された橋の番号（`SHIMANAMI.bridges` の並び） */
const 橋の番号 = (locations) => locations
  .filter((l) => l.type === "through")
  .map((l) => SHIMANAMI.bridges.findIndex(([lon, lat]) => lon === l.lon && lat === l.lat));

test("本州から四国へは、橋を尾道側から順に全部渡らせる", () => {
  const out = shimanamiLocations([loc(尾道), loc(今治)], [しまなみの船]);
  assert.ok(out, "足していない");
  // 尾道大橋（0）から来島海峡大橋（6）まで7本
  assert.deepStrictEqual(橋の番号(out), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(out[0], loc(尾道), "出発地が変わった");
  assert.deepStrictEqual(out[out.length - 1], loc(今治), "目的地が変わった");
});

test("四国から本州へは、同じ橋を逆の順に渡らせる", () => {
  const out = shimanamiLocations([loc(今治), loc(尾道)], [しまなみの船]);
  assert.deepStrictEqual(橋の番号(out), [6, 5, 4, 3, 2, 1, 0]);
});

test("遠くの出発地でも、四国の中かどうかで入口を決める", () => {
  // ⚠️ **近さで決めないこと。** 広島（本州）は今治のほうが近く、
  //    高松（四国）は尾道のほうが近い。近さで決めると逆から入って島を往復する
  assert.deepStrictEqual(橋の番号(shimanamiLocations([loc(東京), loc(松山)], [しまなみの船])),
                         [0, 1, 2, 3, 4, 5, 6], "東京→松山");
  assert.deepStrictEqual(橋の番号(shimanamiLocations([loc(高松), loc(広島)], [しまなみの船])),
                         [6, 5, 4, 3, 2, 1, 0], "高松→広島");
  assert.strictEqual(chainEntry(広島), -1, "広島を本州とみなしていない");
  assert.strictEqual(chainEntry(高松), SHIMANAMI.islands.length, "高松を四国とみなしていない");
});

test("今治は大島ではなく四国とみなす（来島海峡大橋を渡らせる）", () => {
  // ⚠️ 今治は大島の点から 7.3km。島の判定を先にすると大島の上とみなし、
  //    いちばん船に回りやすい来島海峡大橋の点を足さなくなる
  assert.strictEqual(chainEntry(今治), SHIMANAMI.islands.length);
  const out = shimanamiLocations([loc(土生), loc(今治)], [しまなみの船]);
  assert.ok(橋の番号(out).includes(6), "来島海峡大橋を足していない");
});

test("橋のそばの端点も、隣の島と取り違えない", () => {
  // ⚠️ **島の上の1点からの近さで決めていたら、4か所とも隣の島と取り違えた**
  //    （実測 2026-09-23）。取り違えると手前の橋を往復し、採れずに船が残る
  //    （因島の北端→今治で船 17.8km）。島の輪郭で決める
  assert.strictEqual(chainEntry([133.178, 34.342]), 1, "因島の北端（因島大橋の南）");
  assert.strictEqual(chainEntry([133.060, 34.205]), 4, "伯方島の北端（大三島橋の南）");
  assert.strictEqual(chainEntry([133.130, 34.290]), 2, "生口島の東（生口橋の西）");
  assert.strictEqual(chainEntry([133.065, 34.170]), 5, "大島の北（伯方・大島大橋の南）");
});

test("船で渡る近くの島は、隣の鎖の島の続きとみなす", () => {
  // ⚠️ 本州とみなすと尾道大橋から全部の橋を渡らせ、生名島→今治が 105km（船 7.9km）に
  //    なった（実測 2026-09-23）。隣の因島へ渡れば 60km 弱で済む
  assert.strictEqual(chainEntry([133.18, 34.26]), 1, "生名島→因島");
  assert.strictEqual(chainEntry([133.146, 34.258]), 2, "岩城島→生口島");
  assert.strictEqual(chainEntry([133.216, 34.264]), 1, "弓削島→因島");
  assert.deepStrictEqual(橋の番号(shimanamiLocations([loc([133.18, 34.26]), loc(今治)], [しまなみの船])),
                         [2, 3, 4, 5, 6], "生名島→今治で、因島より手前の橋を渡らせている");
});

test("鎖から離れた島は本州とみなす", () => {
  // 大崎上島（鎖の島から 2km 以上）。足して取り違えても、往復は bridgePasses が弾く
  assert.strictEqual(chainEntry([132.935, 34.245]), -1, "大崎上島");
});

test("島の上から出るなら、その島より手前の橋は渡らせない", () => {
  // 因島の土生 → 今治: 生口橋（2）から先だけ。因島大橋（1）を足すと向島へ戻る
  assert.strictEqual(chainEntry(土生), 1, "土生を因島の上とみなしていない");
  assert.deepStrictEqual(橋の番号(shimanamiLocations([loc(土生), loc(今治)], [しまなみの船])),
                         [2, 3, 4, 5, 6]);
});

test("島の上が目的地なら、その島の先の橋は渡らせない", () => {
  // 尾道 → 大三島の宮浦: 多々羅大橋（3）まで。大三島橋（4）を足すと伯方島へ行って戻る
  assert.strictEqual(chainEntry(宮浦), 3, "宮浦を大三島の上とみなしていない");
  assert.deepStrictEqual(橋の番号(shimanamiLocations([loc(尾道), loc(宮浦)], [しまなみの船])),
                         [0, 1, 2, 3]);
});

test("四国へ渡らない船では何もしない", () => {
  // 宇野→直島（どちらも本州側）。⚠️ 四国と関係ない船で経由地を足すと遠回りになる
  assert.strictEqual(shimanamiLocations([loc(尾道), loc(今治)], [宇野直島]), null);
  assert.strictEqual(shimanamiLocations([loc(尾道), loc(今治)], []), null);
});

test("しまなみの外でも、本州と四国を結ぶ船なら足す", () => {
  // ⚠️ **いちばん直したい長い経路がこれ。** 実測: 新座→今治は宇野－直島－高松の船
  const out = shimanamiLocations([loc(東京), loc(今治)], [宇野直島, 直島高松]);
  assert.ok(out, "四国へ渡る船なのに足していない");
  assert.deepStrictEqual(橋の番号(out), [0, 1, 2, 3, 4, 5, 6]);
});

test("同じ島の中なら足さない", () => {
  const 大三島の東 = [133.04, 34.24];
  assert.strictEqual(shimanamiLocations([loc(宮浦), loc(大三島の東)], [しまなみの船]), null);
});

test("立ち寄り先の並びを崩さず、船がいた区間にだけ差し込む", () => {
  // 東京 → 尾道（立ち寄り） → 今治。船は尾道と今治の間
  const out = shimanamiLocations(
    [loc(東京), loc(尾道, "break"), loc(今治)], [しまなみの船]);
  assert.deepStrictEqual(out.slice(0, 2), [loc(東京), loc(尾道, "break")],
                         "船の無い区間に足している");
  assert.deepStrictEqual(橋の番号(out), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(out[out.length - 1], loc(今治));
  // ⚠️ **through で入れること。** break にすると、橋ごとに「着きました」と言う
  assert.ok(out.filter((l) => SHIMANAMI.bridges.some(([x, y]) => x === l.lon && y === l.lat))
    .every((l) => l.type === "through"), "橋の点を止まる場所にしている");
});

test("出発地が橋の点のすぐそばなら、その橋の点は足さない", () => {
  // 大三島橋の点から北へ約10m（伯方島の上とみなされる）→ 尾道。
  // 渡る橋は大三島橋（4）から尾道大橋（0）までだが、大三島橋の点は出発地と重なる。
  // ⚠️ 同じ場所に点が2つ並ぶと Valhalla が `leg_shape_index not set` で落ちる
  const [lon, lat] = SHIMANAMI.bridges[4];
  const 橋の上 = [lon, lat + 0.00009];
  assert.strictEqual(chainEntry(橋の上), 4, "材料が悪い: 伯方島の上とみなされていない");
  assert.deepStrictEqual(橋の番号(shimanamiLocations([loc(橋の上), loc(尾道)], [しまなみの船])),
                         [3, 2, 1, 0]);
});

// MARK: 島を往復していないか（`bridgePasses`）

/** 点から点へ、約10mおきに点を打った線（経路の形の代わり） */
const 線 = (...通る) => {
  const out = [];
  for (let i = 0; i < 通る.length - 1; i++) {
    const [a, b] = [通る[i], 通る[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot((b[0] - a[0]) * 92_000, (b[1] - a[1]) * 111_000) / 10));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(通る[通る.length - 1]);
  return out;
};
/** 橋の点から北へ約30mずらした点（⚠️ 真上を通る線だけでは、近さの幅を確かめられない） */
const 橋のそば = (j) => [SHIMANAMI.bridges[j][0], SHIMANAMI.bridges[j][1] + 0.00027];

test("橋を1本ずつ渡る経路なら、どの橋も1回と数える", () => {
  // ⚠️ 点は約10mおき。橋のそばに何点並んでも、渡ったのは1回
  const passes = bridgePasses(線(尾道, 橋のそば(1), 橋のそば(2), 橋のそば(3),
                                   橋のそば(4), 橋のそば(5), 橋のそば(6), 今治));
  assert.deepStrictEqual(passes.slice(1), [1, 1, 1, 1, 1, 1]);
});

test("島を往復する経路は、同じ橋を2回と数える", () => {
  // 向島 → 生口橋を越えて大三島まで行き、生口橋を戻って因島へ（入口の取り違えで起きる形）
  const passes = bridgePasses(線(尾道, 橋のそば(1), 橋のそば(2), 橋のそば(3),
                                   橋のそば(2), SHIMANAMI.islands[1]));
  assert.strictEqual(passes[2], 2, "往復した生口橋を2回と数えていない");
  assert.strictEqual(passes[3], 1);
});

test("橋から離れた経路は、どの橋も0回", () => {
  // 広島→松江（中国山地）。しまなみと関係ない
  assert.ok(bridgePasses(線([132.46, 34.39], [133.05, 35.47])).every((n) => n === 0));
});
