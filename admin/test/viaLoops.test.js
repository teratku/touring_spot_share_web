"use strict";
const test = require("node:test");
const assert = require("node:assert");
const viaLoops = require("../lib/viaLoops");
const { distance } = require("../lib/routeLoops");

/**
 * 経由地のまわりの輪（Uターン路）の見つけ方と直し方（`lib/viaLoops.js`）。
 *
 * ⚠️ **形はツーリング3で実際に出た3つを写したもの**（2026-09-23 実機で報告）。
 *    線はメートルで描いて緯度経度に直す（10mおきの点）。本物の経路での確かめは
 *    `valhallaLive.test.js` の「経由地の輪:」。
 */
const O = [140.0, 38.0];
const KX = 111_320 * Math.cos((O[1] * Math.PI) / 180);
const KY = 110_540;
const at = ([x, y]) => [O[0] + x / KX, O[1] + y / KY];
/** 折れ線の角（m）を、10mおきの点の線にする */
function line(...corners) {
  const out = [];
  for (let k = 0; k + 1 < corners.length; k++) {
    const [ax, ay] = corners[k];
    const [bx, by] = corners[k + 1];
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 10));
    for (let s = 0; s < steps; s++) out.push(at([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]));
  }
  out.push(at(corners[corners.length - 1]));
  return out;
}
/** 点 p が、m 単位でどこか（原点からの東・北） */
const xy = (p) => [(p[0] - O[0]) * KX, (p[1] - O[1]) * KY];
const ctx = (found, points, vias, kinds, extra = {}) => ({
  points, cum: found.cum, at: found.at, kinds, vias,
  headings: vias.map(() => undefined), tried: new Set(), ...extra,
});

/**
 * 286号の終点の形: 道を東へ走って終点に着き、次の行き先は**後ろ**（400m手前の分岐を北）。
 * 終点で向きを変えられないので、先へ進んで街区を回り、道を戻ってくる。
 */
function endBehind({ junctionX = -400, fromX = -1500 } = {}) {
  const points = line([fromX - 500, 0], [0, 0], [60, 0], [60, -300], [100, -340], [20, -340],
    [60, -300], [60, 0], [junctionX, 0], [junctionX, 1000]);
  const vias = [at([fromX, 0]), at([0, 0])];
  return { points, vias, kinds: ["through", "break_through"] };
}

/**
 * 347号の終点の形: 道（東西）を外れて北の並行路を走り、終点の**東**から道へ降りて
 * 西向きに終点へ着く（裏側から着く）。そのまま西へ進んで街区を回り、降りてきた道を戻る。
 */
function endWrongSide() {
  const points = line([-2500, 0], [-1500, 0], [-1500, 500], [100, 500], [100, 0], [0, 0],
    [-30, 0], [-30, -200], [100, -200], [100, 0], [100, 500], [1000, 500]);
  const vias = [at([-2000, 0]), at([0, 0])];
  return { points, vias, kinds: ["through", "break_through"] };
}

/** 行き止まりの終点: 着いたらその場で折り返す */
function deadEnd() {
  const points = line([-1500, 0], [0, 0], [-500, 0], [-500, 1000]);
  const vias = [at([-1000, 0]), at([0, 0])];
  return { points, vias, kinds: ["through", "break_through"] };
}

/**
 * 347号の入口の形: 南から来て、入口（西端）より**東**で道に出る。入口まで西へ戻り、
 * 三角に回って合流点へ戻り、東へ走る。
 */
function entranceInside({ joinX = 100 } = {}) {
  const points = line([joinX, -1000], [joinX, 0], [0, 0], [-50, 0], [-50, -150], [joinX, -150],
    [joinX, 0], [2500, 0]);
  const vias = [at([0, 0]), at([2000, 0])];
  return { points, vias, kinds: ["through", "through"] };
}

test("経由地は前から順に探す（後ろの経由地の場所を、行きがけにかすめても取り違えない）", () => {
  // v1 の場所を先に通り過ぎ、v0 で折り返してから v1 に着く
  const points = line([0, 0], [1000, 0], [1500, 0], [1000, 0], [1000, 800]);
  const v0 = at([1500, 0]);
  const v1 = at([1000, 400]);
  const found = viaLoops.locateVias(points, [v0, v1]);
  assert.ok(found[0] !== null && found[1] !== null, `材料が悪い: 経由地が線の上に無い ${found}`);
  assert.ok(distance(points[found[0]], v0) < 5, "v0 の場所を取り違えている");
  assert.ok(found[1] > found[0],
    `v1 を v0 より前（行きがけ）で見つけている: v0=${found[0]} v1=${found[1]}`);
  // ⚠️ v1 の場所（1000,400）は行きがけの線（y=0）から400m。材料として、
  //    行きがけにかすめる形にするため、v1 を曲がり角へ寄せた版でも確かめる
  const v1b = at([1000, 0]);
  const again = viaLoops.locateVias(points, [v0, v1b]);
  assert.ok(again[1] > again[0],
    `曲がり角の v1 を行きがけの通過で取っている: v0=${again[0]} v1=${again[1]}`);
});

test("終点の先で回ってくる輪は、戻り始める分岐の手前まで終点を切る（286号の形）", () => {
  const { points, vias, kinds } = endBehind();
  const found = viaLoops.findViaLoops(points, vias, kinds);
  assert.strictEqual(found.loops.length, 1, `輪の数が違う: ${found.loops.length}`);
  const loop = found.loops[0];
  assert.strictEqual(loop.n, 1, "終点の輪として見つけていない");
  assert.ok(!loop.deadEnd, `行き止まりと取り違えている（戻り始めるまで${Math.round(loop.firstReturn)}m）`);
  // 根元は分岐（x=-400）。そこより手前は二度と通らない
  const [bx] = xy(points[loop.base]);
  assert.ok(Math.abs(bx - -400) <= 40, `根元が分岐でない: x=${Math.round(bx)}`);

  const r = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, "trim", `切らずに ${r.how}（${r.why}）`);
  const [tx, ty] = xy(r.point);
  // 分岐の手前（道の上）に置く。分岐の真上や先ではまた回り込む。
  // ⚠️ 根元は「戻った」とみなす幅（30m）ぶん分岐より手前に出て、そこからさらに30m離す。
  //    点は10mおきなので、分岐から60〜80m手前になる。
  //    ⚠️ 物差しに実装の定数を使わないこと（幅を変える壊し方で物差しも一緒に動く）
  assert.ok(tx < -400 && tx > -480 && Math.abs(ty) < 5, `切る場所が違う: (${Math.round(tx)}, ${Math.round(ty)})`);
});

test("裏側から着いた終点は、切らずに道なりの向きを付ける（347号の終点の形）", () => {
  const { points, vias, kinds } = endWrongSide();
  const found = viaLoops.findViaLoops(points, vias, kinds);
  assert.strictEqual(found.loops.length, 1, `輪の数が違う: ${found.loops.length}`);
  const loop = found.loops[0];
  assert.ok(!loop.deadEnd, "行き止まりと取り違えている");
  const r = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, "heading", `向きでなく ${r.how}（${r.why}）`);
  // 道なり＝前の点から終点への向き（東・90度）
  assert.ok(viaLoops.angleBetween(r.heading, 90) < 5, `向きが道なりでない: ${r.heading}`);

  // ⚠️ 向きを試してだめなら、切る方へ移る（同じことを繰り返さない）
  const next = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds, { tried: new Set(["heading"]) }));
  assert.notStrictEqual(next.how, "heading", "試してだめだった向きをまた付けている");
  // ⚠️ すでに向きが付いている終点に、重ねて付けない
  const already = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds, { headings: [undefined, 90] }));
  assert.notStrictEqual(already.how, "heading", "向きの付いた終点にまた向きを付けている");
});

test("その場で折り返す行き止まりの終点は触らない", () => {
  // ⚠️ 利用者の判断: 引き返すしか無い場所では引き返してよい（石廊崎）
  const { points, vias, kinds } = deadEnd();
  const found = viaLoops.findViaLoops(points, vias, kinds);
  assert.strictEqual(found.loops.length, 1, "材料が悪い: 往復を輪として見つけていない");
  assert.ok(found.loops[0].deadEnd,
    `行き止まりと見なしていない（戻り始めるまで${Math.round(found.loops[0].firstReturn)}m）`);
  const r = viaLoops.remedyFor(found.loops[0], ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, null, `行き止まりを ${r.how} で直そうとしている`);
});

test("内側から入口に着いた通る点は、合流点の少し先へずらす（347号の入口の形）", () => {
  const { points, vias, kinds } = entranceInside();
  const found = viaLoops.findViaLoops(points, vias, kinds);
  const loop = found.loops.find((l) => l.n === 0);
  assert.ok(loop, "入口の輪を見つけていない");
  const r = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, "move", `ずらさずに ${r.how}（${r.why}）`);
  const [mx, my] = xy(r.point);
  // 合流点（x=100）を東へ抜けた所。入口側（西）や合流点の手前へ戻さない
  assert.ok(mx > 100 && mx < 250 && Math.abs(my) < 5, `ずらす先が違う: (${Math.round(mx)}, ${Math.round(my)})`);
});

test("立ち寄り先（スポット）は、寄って戻る形でも触らない", () => {
  const { points, vias } = endBehind();
  const found = viaLoops.findViaLoops(points, vias, ["through", "break"]);
  assert.strictEqual(found.loops.length, 0, "スポットのまわりを輪として直そうとしている");
  // ⚠️ **直し方を決める側でも触らない**（二重の守り）。入口の形（ずらす先が合流点の少し先で、
  //    300mの上限に掛からない）を通る点として見つけ、種別だけスポットにして渡す。
  //    ⚠️ 遠くへずらす形で確かめないこと。上限に止められて、守りを外しても通ってしまう
  const e = entranceInside();
  const asThrough = viaLoops.findViaLoops(e.points, e.vias, e.kinds);
  const loop = asThrough.loops.find((l) => l.n === 0);
  assert.ok(loop, "材料が悪い: 入口の輪が無い");
  assert.strictEqual(viaLoops.remedyFor(loop, ctx(asThrough, e.points, e.vias, e.kinds)).how, "move",
    "材料が悪い: 通る点としてならずらす形でない");
  const r = viaLoops.remedyFor(loop, ctx(asThrough, e.points, e.vias, ["break", "through"]));
  assert.strictEqual(r.how, null, `スポットを ${r.how} で動かそうとしている`);
});

test("終点を切るのは1,000mまで", () => {
  // 分岐が終点の1,200m手前: 切ると1,230m
  const { points, vias, kinds } = endBehind({ junctionX: -1200, fromX: -4000 });
  const found = viaLoops.findViaLoops(points, vias, kinds);
  assert.strictEqual(found.loops.length, 1, "材料が悪い: 輪を見つけていない");
  const r = viaLoops.remedyFor(found.loops[0], ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, null, `1,230m 切ろうとしている（${r.how}）`);
  // 材料の確かめ: 分岐が400m手前なら切る（上限だけで止まっていること）
  const near = endBehind({ junctionX: -400, fromX: -4000 });
  const f2 = viaLoops.findViaLoops(near.points, near.vias, near.kinds);
  assert.strictEqual(viaLoops.remedyFor(f2.loops[0], ctx(f2, near.points, near.vias, near.kinds)).how,
    "trim", "材料が悪い: 近い分岐でも切らない");
});

test("終点を切るのは、その道を走る長さの半分まで", () => {
  // 道の入口（前の点）が終点の600m手前: 430m切ると半分を超える
  const { points, vias, kinds } = endBehind({ junctionX: -400, fromX: -600 });
  const found = viaLoops.findViaLoops(points, vias, kinds);
  assert.strictEqual(found.loops.length, 1, "材料が悪い: 輪を見つけていない");
  const r = viaLoops.remedyFor(found.loops[0], ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, null, `道の7割を切ろうとしている（${r.how}）`);
});

test("通る点をずらすのは300mまで（道を飛ばしてまで輪をほどかない）", () => {
  // 合流点が入口の400m東: ずらすと約460m
  const { points, vias, kinds } = entranceInside({ joinX: 400 });
  const found = viaLoops.findViaLoops(points, vias, kinds);
  const loop = found.loops.find((l) => l.n === 0);
  assert.ok(loop, "材料が悪い: 入口の輪を見つけていない");
  const r = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, null, `入口を400m以上ずらそうとしている（${r.how}）`);
  // ⚠️ 試してだめだった点を、またずらさない
  const small = entranceInside();
  const f2 = viaLoops.findViaLoops(small.points, small.vias, small.kinds);
  const l2 = f2.loops.find((l) => l.n === 0);
  const again = viaLoops.remedyFor(l2, ctx(f2, small.points, small.vias, small.kinds, { tried: new Set(["move"]) }));
  assert.strictEqual(again.how, null, "試してだめだった点をまたずらしている");
});

test("輪の無い経路では何もしない", () => {
  const points = line([-2000, 0], [0, 0], [2000, 0]);
  const vias = [at([-1000, 0]), at([0, 0]), at([1000, 0])];
  const found = viaLoops.findViaLoops(points, vias, ["through", "break_through", "through"]);
  assert.strictEqual(found.loops.length, 0, `まっすぐな道に輪を見ている: ${found.loops.length}`);
});

test("終点を切っても、道の最後の中継点より手前には置かない", () => {
  // 長い道（入口は終点の3km手前）で、最後の中継点が終点の300m手前。
  // 経路は終点の先で回り、最後の中継点を過ぎて400m手前の分岐まで戻る。
  // 戻り始める所（根元）は最後の中継点そのものになり、30m離すと中継点より手前に出る
  const points = line([-3500, 0], [0, 0], [60, 0], [60, -300], [100, -340], [20, -340],
    [60, -300], [60, 0], [-400, 0], [-400, 1000]);
  const vias = [at([-3000, 0]), at([-300, 0]), at([0, 0])];
  const kinds = ["through", "through", "break_through"];
  const found = viaLoops.findViaLoops(points, vias, kinds);
  const loop = found.loops.find((l) => l.n === 2);
  assert.ok(loop, "材料が悪い: 終点の輪を見つけていない");
  // 材料の確かめ: 1,000m・道の半分の上限には掛からない長さ（切るのは330m・道は3,000m）
  assert.ok(Math.abs(xy(points[loop.base])[0] - -300) <= 10, "材料が悪い: 根元が最後の中継点でない");
  const r = viaLoops.remedyFor(loop, ctx(found, points, vias, kinds));
  assert.strictEqual(r.how, null,
    `終点を最後の中継点より手前へ切ろうとしている（${r.how}${r.point ? ` x=${Math.round(xy(r.point)[0])}` : ""}）`);
});

test("直し方を当てるとき、元の経由地は変えず、向きの許容角を付け、動かした点の向きは消す", () => {
  const 元 = { lat: 38.0, lon: 140.0, type: "break_through", heading: 10, heading_tolerance: 45 };
  const 写し = JSON.stringify(元);

  const 向き = viaLoops.applyRemedy({ lat: 38.0, lon: 140.0, type: "break_through" }, { how: "heading", heading: 118 });
  assert.strictEqual(向き.heading, 118, "向きが付いていない");
  // ⚠️ **許容角は45度。** 付けないと Valhalla の既定の許容角になり、道の入口の向き（45度）と揃わない
  assert.strictEqual(向き.heading_tolerance, 45, `許容角が ${向き.heading_tolerance}`);
  assert.deepStrictEqual([向き.lon, 向き.lat, 向き.type], [140.0, 38.0, "break_through"], "向き以外を変えている");

  const 動かした = viaLoops.applyRemedy(元, { how: "move", point: [140.001, 38.002] });
  assert.deepStrictEqual([動かした.lon, 動かした.lat], [140.001, 38.002], "動かしていない");
  assert.strictEqual(動かした.type, "break_through", "種別を変えている（立ち寄りの知らせが消える）");
  // ⚠️ 動かした先は道の別の場所。元の向きを残すと、その向きで入れない点になる
  assert.ok(!("heading" in 動かした) && !("heading_tolerance" in 動かした), "動かした点に元の向きが残っている");
  assert.strictEqual(JSON.stringify(元), 写し, "元の経由地を書き換えている（採らなかったときに戻らない）");
});

test("引き直した経路は、短くなり・輪が減り・船が増えないときだけ採る", () => {
  const 前 = { meters: 555_400, loops: 3, ferryMeters: 0 };
  assert.strictEqual(viaLoops.shouldAccept(前, { meters: 551_500, loops: 0, ferryMeters: 0 }), true,
    "ツーリング3の直し（555.4→551.5km・輪3→0）を採らない");
  // ⚠️ 長くなるなら採らない（実測: 引き直すと 147→218km になる形があった）
  assert.strictEqual(viaLoops.shouldAccept(前, { meters: 718_000, loops: 1, ferryMeters: 0 }), false,
    "長くなったのに採っている");
  // ⚠️ 形が同じまま点だけ動いた（ほぼ同じ長さ）なら採らない
  assert.strictEqual(viaLoops.shouldAccept(前, { meters: 555_370, loops: 2, ferryMeters: 0 }), false,
    "30mしか短くならないのに採っている");
  // ⚠️ 輪が減らないなら採らない（別の輪を作っている）
  assert.strictEqual(viaLoops.shouldAccept(前, { meters: 551_500, loops: 3, ferryMeters: 0 }), false,
    "輪が減っていないのに採っている");
  // ⚠️ 船が増えるなら採らない（フェリーを避ける）
  assert.strictEqual(viaLoops.shouldAccept(前, { meters: 551_500, loops: 0, ferryMeters: 12_000 }), false,
    "船に乗る経路を採っている");
});
