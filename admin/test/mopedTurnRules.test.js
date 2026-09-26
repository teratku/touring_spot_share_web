"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rulesLib = require("../lib/mopedTurnRules");
const { placesFromGeometry, ruleAt } = rulesLib;
const { isTwoStageRightTurn, approachHeading, routeWithValhalla, BASE } = require("../lib/valhallaRoute");
const { fromRow, signalsToBin, toOutput } = require("../buildJarticMopedTurns");
const trafficSignals = require("../lib/trafficSignals");

/**
 * 原付の右折方法の標識（JARTIC の 55=二段階・56=小回り）で、二段階右折の判定を直す。
 *
 * ⚠️ 利用者の判断（2026-09-25）。数字は実際の JARTIC の行（2026年07月分）から写した:
 *    大阪駅前西の小回り（3点の線）: 135.495220946406 34.7006697520626;135.495247644425 34.7006304315854;
 *    135.495202509135 34.7006051020588 ＝ 南へ入って（150°）右へ（西）。経路は入る向き149°・曲がる地点から42m
 */
const OSAKA_WEST_SMALL_TURN = "135.495220946406 34.7006697520626;135.495247644425 34.7006304315854;135.495202509135 34.7006051020588";
const OSAKA_WEST = [135.495044, 34.70097];

test("3点で右へ曲がる線は、向きのある標識にする", () => {
  const [p] = placesFromGeometry(OSAKA_WEST_SMALL_TURN);
  assert.deepStrictEqual(p.at, [135.495247644425, 34.7006304315854], "曲がり角の点");
  assert.ok(Math.abs(p.inHeading - 150) <= 2, `入る向き ${p.inHeading}`);
  assert.strictEqual(placesFromGeometry(OSAKA_WEST_SMALL_TURN).length, 1);
});

test("点・2点・右へ曲がらない形は、向きの無い標識にする", () => {
  // 点だけ（愛知・兵庫など）
  assert.deepStrictEqual(placesFromGeometry("135.1 34.6"), [{ at: [135.1, 34.6], inHeading: null }]);
  // 2点（茨城）は向きを確かめられないので点ごと
  assert.deepStrictEqual(placesFromGeometry("140.1 36.1;140.1 36.1001").map((x) => x.inHeading), [null, null]);
  // 3点でも左へ曲がる形は向きを採らない
  const left = placesFromGeometry("135.0 35.0;135.0 35.0002;134.9998 35.0002");
  assert.deepStrictEqual(left.map((x) => x.inHeading), [null, null, null]);
  // 「/」で区切られた複数の線
  assert.strictEqual(placesFromGeometry(`${OSAKA_WEST_SMALL_TURN}/135.2 34.7`).length, 2);
  // ⚠️ 壊れた値は捨てる（実測: 信号の行に #VALUE! が1件）
  assert.deepStrictEqual(placesFromGeometry("#VALUE!"), []);
  assert.deepStrictEqual(placesFromGeometry("#VALUE! 34.7"), [], "片方だけ壊れた値を捨てていない");
  assert.deepStrictEqual(placesFromGeometry("135.5 34.7;135.5 x"), [{ at: [135.5, 34.7], inHeading: null }]);
  assert.deepStrictEqual(placesFromGeometry(""), []);
});

const rule = (kind, at, inHeading = null) => ({ kind, at, inHeading });

test("向きのある標識は、入る向きまで合うときだけ当てる（大阪駅前西）", () => {
  const rules = placesFromGeometry(OSAKA_WEST_SMALL_TURN).map((p) => ({ kind: "smallTurn", ...p }));
  const hit = ruleAt(OSAKA_WEST, 149, rules);
  assert.strictEqual(hit && hit.kind, "smallTurn");
  assert.ok(hit.directed);
  assert.ok(hit.meters > 35 && hit.meters < 50, `距離 ${hit.meters}`);
  // ⚠️ 別の向きから入る右折には当てない（実測: 3m 先に向き81°違いの行があった）
  assert.strictEqual(ruleAt(OSAKA_WEST, 149 + 81, rules), null);
  assert.strictEqual(ruleAt(OSAKA_WEST, 149 - 45, rules), null);
  assert.ok(ruleAt(OSAKA_WEST, 149 + 35, rules), "40°以内は当てる");
  // 向きが分からなければ当てない
  assert.strictEqual(ruleAt(OSAKA_WEST, null, rules), null);
});

test("向きのある標識は50mまで、点だけの標識は30mまで", () => {
  const at = [135.0, 35.0];
  const north = (m) => [135.0, 35.0 + m / 111320];
  assert.ok(ruleAt(at, 0, [rule("smallTurn", north(48), 0)]));
  assert.strictEqual(ruleAt(at, 0, [rule("smallTurn", north(55), 0)]), null);
  assert.ok(ruleAt(at, 0, [rule("smallTurn", north(28))]));
  assert.strictEqual(ruleAt(at, 0, [rule("smallTurn", north(35))]), null, "点だけの標識を35m先まで拾っている");
  // 東西に離れた点も距離で見る（緯度の帯だけで決めない）
  assert.strictEqual(ruleAt(at, 0, [rule("smallTurn", [135.001, 35.0])]), null);
});

test("向きのある標識を先に、同じ確かさなら近いほう", () => {
  const at = [135.0, 35.0];
  const north = (m) => [135.0, 35.0 + m / 111320];
  // 近くの点は小回り、少し先の向きのある線は二段階 → 向きのあるほう
  assert.strictEqual(ruleAt(at, 0, [rule("smallTurn", north(5)), rule("twoStage", north(40), 0)].sort((a, b) => a.at[1] - b.at[1])).kind, "twoStage");
  // 点どうしなら近いほう
  assert.strictEqual(ruleAt(at, 0, [rule("twoStage", north(20)), rule("smallTurn", north(8))].sort((a, b) => a.at[1] - b.at[1])).kind, "smallTurn");
  assert.strictEqual(ruleAt(at, 0, [rule("twoStage", north(8)), rule("smallTurn", north(20))]).kind, "twoStage");
  // ⚠️ 並び（緯度順）で先に来るほうではなく、近いほう（南20mの二段階より、北8mの小回り）
  const south = (m) => [135.0, 35.0 - m / 111320];
  assert.strictEqual(ruleAt(at, 0, [rule("twoStage", south(20)), rule("smallTurn", north(8))]).kind, "smallTurn");
  assert.strictEqual(ruleAt(at, 0, []), null);
});

test("標識があればそちらが先、無ければ法の既定", () => {
  const turn = { maneuver: "turnRight", atSignal: true, approachLaneCount: 4 };
  // 小回りの標識: 片側4車線・信号ありでも小回り
  assert.strictEqual(isTwoStageRightTurn(turn, "moped50", { sign: "smallTurn" }), false);
  // 二段階の標識: 片側1車線でも二段階（信号は見ない）
  assert.strictEqual(isTwoStageRightTurn({ maneuver: "turnRight", atSignal: false, approachLaneCount: 1 }, "moped50", { sign: "twoStage" }), true);
  // 標識が無ければ法の既定
  assert.strictEqual(isTwoStageRightTurn(turn, "moped50", { sign: null }), true);
  // 原付でなければ標識があっても小回り
  assert.strictEqual(isTwoStageRightTurn(turn, "small125", { sign: "twoStage" }), false);
  // 右折でなければ標識があっても関係ない
  assert.strictEqual(isTwoStageRightTurn({ ...turn, maneuver: "turnLeft" }, "moped50", { sign: "twoStage" }), false);
});

test("信号は OSM か JARTIC のどちらかにあればよい", () => {
  const turn = { maneuver: "turnRight", atSignal: false, approachLaneCount: 3 };
  assert.strictEqual(isTwoStageRightTurn(turn, "moped50", {}), false);
  assert.strictEqual(isTwoStageRightTurn(turn, "moped50", { jarticSignal: true }), true);
  assert.strictEqual(isTwoStageRightTurn({ ...turn, approachLaneCount: 2 }, "moped50", { jarticSignal: true }), false);
});

test("入る向きは30m手前の点から測る", () => {
  // 南から北へ 10m おき、最後の10m だけ東へ折れる → 30m 手前から見るとほぼ北
  const pts = [0, 10, 20, 30, 40].map((m) => [135.0, 35.0 + m / 111320]);
  pts.push([135.0 + 10 / 91000, 35.0 + 40 / 111320]);
  const h = approachHeading(pts, pts.length - 1);
  assert.ok(h > 5 && h < 30, `向き ${h}`);
  assert.strictEqual(approachHeading(pts, 0), null, "手前が無ければ分からない");
});

test("JARTIC の行から標識と信号を取り出す", () => {
  const small = fromRow({ "共通規制種別コード": "56", "規制場所の経度緯度": OSAKA_WEST_SMALL_TURN, "ユニークキー": "k1" }, "大阪府");
  assert.deepStrictEqual(small.rules.map((r) => [r.kind, r.prefecture, r.key]), [["smallTurn", "大阪府", "k1"]]);
  const two = fromRow({ "共通規制種別コード": "55", "規制場所の経度緯度": "140.2 36.3" }, "茨城県");
  assert.deepStrictEqual(two.rules.map((r) => r.kind), ["twoStage"]);
  const sig = fromRow({ "共通規制種別コード": "98", "規制場所の経度緯度": "135.5 34.7" }, "大阪府");
  assert.deepStrictEqual(sig, { rules: [], signals: [[135.5, 34.7]] });
  // ほかの規制（一時停止など）は取らない
  assert.deepStrictEqual(fromRow({ "共通規制種別コード": "63", "規制場所の経度緯度": "135.5 34.7" }, "大阪府"),
                         { rules: [], signals: [] });
});

test("書き出す標識は緯度順で、出典と加工の明記がある", () => {
  const rules = [rule("smallTurn", [135, 35.2]), rule("twoStage", [135, 34.9]), rule("smallTurn", [135, 35.0])];
  const out = toOutput(rules, { 大阪府: {} }, { targetMonth: "2026年07月", releaseDay: "2026年09月01日" },
                       new Date("2026-09-26T00:00:00Z"));
  assert.deepStrictEqual(out.rules.map((r) => r.at[1]), [34.9, 35.0, 35.2]);
  assert.ok(/日本道路交通情報センター/.test(out.attribution) && /加工/.test(out.attribution) && /2026-09-26/.test(out.attribution));
  assert.strictEqual(out.targetMonth, "2026年07月");
});

test("信号の書き出しは trafficSignals と同じ形で、2つのファイルを取り違えない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsig-"));
  const a = path.join(dir, "a.bin"), b = path.join(dir, "b.bin");
  // ⚠️ 渡す順は緯度順でない（書き出す側で並べる）
  fs.writeFileSync(a, signalsToBin([[139.7, 35.6], [135.5, 34.7]]));
  fs.writeFileSync(b, signalsToBin([[140.0, 36.0]]));
  trafficSignals.reset();
  try {
    assert.strictEqual(trafficSignals.count(a), 2);
    assert.ok(trafficSignals.isNear([135.5, 34.7], 5, a));
    assert.ok(trafficSignals.isNear([139.7, 35.6], 5, a), "緯度順に並べていない");
    // ⚠️ 1つだけ持つ作りだと、b を頼んでも a を返す
    assert.strictEqual(trafficSignals.count(b), 1);
    assert.ok(!trafficSignals.isNear([135.5, 34.7], 5, b));
    assert.ok(trafficSignals.isNear([140.0, 36.0], 5, b));
  } finally {
    trafficSignals.reset();
  }
});

// MARK: 作ったデータ

test("全国の標識と信号を読める（出典つき）", () => {
  const data = JSON.parse(fs.readFileSync(rulesLib.FILE, "utf8"));
  assert.ok(/日本道路交通情報センター/.test(data.attribution) && /加工/.test(data.attribution), "出典と加工の明記が無い");
  assert.strictEqual(Object.keys(data.counts).length, 47, "47都道府県そろっていない");
  // 実測（2026年07月分）: 標識15,687か所・信号219,048点。⚠️ 大きく減ったら取り込みが壊れている
  assert.ok(data.rules.length > 10000, `標識が ${data.rules.length} しかない`);
  assert.ok(data.rules.filter((r) => r.kind === "twoStage").length > 1000, "二段階の標識が少なすぎる");
  assert.ok(data.rules.every((r, i) => i === 0 || data.rules[i - 1].at[1] <= r.at[1]), "緯度順に並んでいない（探し方が狂う）");
  trafficSignals.reset();
  assert.ok(trafficSignals.count(trafficSignals.JARTIC_FILE) > 200000, "JARTIC の信号が少なすぎる");
  trafficSignals.reset();
});

// MARK: 実際の Valhalla で

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`);
/** 経路の中の、名前の付いた交差点の右折 */
async function rightTurn(from, to, displacement, name) {
  const r = await routeWithValhalla(from, to, { displacement });
  assert.ok(!r.error, r.error);
  const s = r.steps.find((x) => (x.maneuver === "turnRight" || x.maneuver === "turnSharpRight")
    && (name === undefined || x.intersectionName === name));
  assert.ok(s, `材料が悪い（${displacement}）: ${name} で右折していない`);
  return s;
}

test("小回りの標識があれば、片側3車線以上でも二段階と言わない（大阪駅前西・税関本庁前）", async (t) => {
  if (await skipIfDown(t)) return;
  // 大阪駅前西: 向きのある標識（入る向き149°・42m）。手前は片側4車線・信号あり
  const west = await rightTurn([135.4950, 34.7020], [135.4925, 34.6960], "moped50", "大阪駅前西");
  assert.ok(west.approachLaneCount >= 3 && west.atSignal, "材料が悪い: 法の既定なら二段階になる所ではない");
  assert.strictEqual(west.mopedTurnSign, "smallTurn");
  assert.strictEqual(west.twoStageRightTurn, false);
  // 税関本庁前（兵庫）: 点だけの標識（5m）。手前は片側3車線・信号あり
  const kobe = await rightTurn([135.2016, 34.6863], [135.1970, 34.6879], "moped50", "税関本庁前");
  assert.ok(kobe.approachLaneCount >= 3 && kobe.atSignal, "材料が悪い");
  assert.strictEqual(kobe.mopedTurnSign, "smallTurn");
  assert.strictEqual(kobe.twoStageRightTurn, false);
});

test("二段階の標識があれば、片側2車線でも二段階（大槻）", async (t) => {
  if (await skipIfDown(t)) return;
  const from = [141.11871, 38.93503], to = [141.1231, 38.93692];
  const s = await rightTurn(from, to, "moped50", "大槻");
  assert.ok(s.approachLaneCount < 3, "材料が悪い: 法の既定でも二段階になる所");
  assert.strictEqual(s.mopedTurnSign, "twoStage");
  assert.strictEqual(s.twoStageRightTurn, true);
  // 原付でなければ小回り。⚠️ 標識は原付の右折でだけ引く（ほかでは引かない）
  const other = await rightTurn(from, to, "small125", "大槻");
  assert.strictEqual(other.twoStageRightTurn, false);
  assert.strictEqual(other.mopedTurnSign, undefined, "原付でないのに標識を引いている");
});

test("標識が無ければ法の既定（則武一丁目）", async (t) => {
  if (await skipIfDown(t)) return;
  const s = await rightTurn([136.87935, 35.1710], [136.8830, 35.1745], "moped50", "則武一丁目");
  assert.strictEqual(s.mopedTurnSign, null);
  assert.ok(s.approachLaneCount >= 3 && s.atSignal, "材料が悪い");
  assert.strictEqual(s.twoStageRightTurn, true);
});

test("OSM に無い信号も JARTIC にあれば信号のある交差点とみなす（石井）", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla([140.2423, 36.3918], [140.2390, 36.3930], { displacement: "moped50" });
  assert.ok(!r.error, r.error);
  const s = r.steps.find((x) => x.maneuver === "turnRight" && x.intersectionName === "石井");
  assert.ok(s, "材料が悪い: 石井で右折していない");
  const at = r.points[s.beginIndex];
  assert.strictEqual(trafficSignals.isNear(at, 20), false, "材料が悪い: OSM に信号がある");
  assert.strictEqual(trafficSignals.isNear(at, 20, trafficSignals.JARTIC_FILE), true, "材料が悪い: JARTIC に信号が無い");
  // ⚠️ 案内の「信号を」も OSM か JARTIC のどちらか（2026-09-26。手前の信号を数えるのと同じ物差し）
  assert.strictEqual(s.atSignal, true, "JARTIC にだけある信号を信号とみなしていない");
  assert.ok(s.approachLaneCount >= 3, "材料が悪い");
  assert.strictEqual(s.mopedTurnSign, null);
  assert.strictEqual(s.twoStageRightTurn, true);
});
