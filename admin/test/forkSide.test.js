"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { forkSide, forkSides, routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * 種類17（分岐を直進）で、経路が左右どちらの道へ分かれるか。
 *
 * ⚠️ **数字は実際の `/trace_attributes` から写した**:
 *    - 新座の国道254号（北向き・柳瀬川の橋）→ 浦和所沢バイパス: 入る向き318°、経路296°、
 *      本線（出て行ける）341°
 *    - 新大宮バイパス: 入る向き162°、経路164°、ほかは合流してくるだけの道（352°・backward）
 */
test("本線より左の道へ進むなら左（新座の国道254号→浦和所沢バイパス）", () => {
  assert.strictEqual(forkSide(318, 296, [{ heading: 341, driveability: "forward", roadClass: "trunk" }]), "left");
  // 同じ節点に左から入ってくるだけの道があっても左（出て行けない道は比べない）
  assert.strictEqual(forkSide(318, 296, [{ heading: 341, driveability: "forward", roadClass: "trunk" },
                                         { heading: 280, driveability: "backward", roadClass: "trunk" }]), "left");
});

test("本線より右の道へ進むなら右", () => {
  assert.strictEqual(forkSide(318, 341, [{ heading: 296, driveability: "forward", roadClass: "trunk" }]), "right");
  assert.strictEqual(forkSide(318, 341, [{ heading: 296, driveability: "both", roadClass: "trunk" }]), "right");
  // 右から交わる道があっても右の分岐（交わる道は比べない）
  assert.strictEqual(forkSide(318, 341, [{ heading: 296, driveability: "forward", roadClass: "trunk" },
                                         { heading: 48, driveability: "both", roadClass: "trunk" }]), "right");
});

test("向きが0°をまたいでも左右を取り違えない", () => {
  // 北を挟む: 入る350°、経路330°（左へ20°）、本線10°（右へ20°）
  assert.strictEqual(forkSide(350, 330, [{ heading: 10, driveability: "forward", roadClass: "trunk" }]), "left");
  assert.strictEqual(forkSide(10, 30, [{ heading: 350, driveability: "forward", roadClass: "trunk" }]), "right");
});

test("出て行けない道は分かれ道に数えない（新大宮バイパス）", () => {
  // ⚠️ 合流してくるだけの道しか無い所は、分かれ道ではない。左右を言わない
  assert.strictEqual(forkSide(162, 164, [{ heading: 352, driveability: "backward", roadClass: "trunk" }]), null);
  assert.strictEqual(forkSide(162, 164, [{ heading: 190, driveability: "backward", roadClass: "trunk" }]), null);
  assert.strictEqual(forkSide(162, 164, []), null);
  // 同じ向きでも、出て行けるなら分かれ道
  assert.strictEqual(forkSide(162, 164, [{ heading: 190, driveability: "forward", roadClass: "trunk" }]), "left");
});

test("横から交わる道は分かれ道に数えない", () => {
  // 経路は左へ22°、右から75°で交わる道だけ → 分かれ道ではない
  assert.strictEqual(forkSide(318, 296, [{ heading: 33, driveability: "both", roadClass: "trunk" }]), null);
  // 60°までは分かれ道
  assert.strictEqual(forkSide(318, 296, [{ heading: 18, driveability: "both", roadClass: "trunk" }]), "left");
});

test("脇道は分かれ道に数えない（国道18号の住宅地の道・姫路の細い道）", () => {
  // ⚠️ 実測（全国216経路）。数えていたら「右車線に入ります」と言うところだった
  //    国道18号（安中）: 入る向きを0°として経路+22°、住宅地の道 −58°・+114°
  assert.strictEqual(forkSide(0, 22, [{ heading: 302, driveability: "both", roadClass: "residential" },
                                      { heading: 114, driveability: "both", roadClass: "residential" }]), null);
  //    姫路: 経路 −12°、名前の無い細い道 −57°
  assert.strictEqual(forkSide(0, 348, [{ heading: 303, driveability: "both", roadClass: "unclassified" }]), null);
  assert.strictEqual(forkSide(0, 348, [{ heading: 303, driveability: "both", roadClass: "service_other" }]), null);
  // 幹線どうしなら分かれ道（札幌の国道5号: 経路+10°、本線 −51°）
  assert.strictEqual(forkSide(0, 10, [{ heading: 309, driveability: "forward", roadClass: "trunk" }]), "right");
  for (const roadClass of ["motorway", "primary", "secondary", "tertiary"]) {
    assert.strictEqual(forkSide(0, 348, [{ heading: 20, driveability: "forward", roadClass }]), "left", roadClass);
  }
});

test("3つに分かれる真ん中は左右を言わない", () => {
  assert.strictEqual(forkSide(0, 0, [{ heading: 340, driveability: "forward", roadClass: "trunk" },
                                     { heading: 20, driveability: "forward", roadClass: "trunk" }]), null);
});

test("合わせ直した線の番号は、合わせ直した線の上の位置で引く", async () => {
  // ⚠️ walk_or_snap の辺の番号は、合わせ直した線（応答の shape）の番号。経路の線の番号とは限らない。
  //    ここでは合わせ直した線の頭に3点多く、分岐は経路の線では2番・合わせ直した線では5番
  const encode6 = (pts) => {
    let out = "", pLat = 0, pLng = 0;
    const put = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
    for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); put(a - pLat); put(b - pLng); pLat = a; pLng = b; }
    return out;
  };
  const route = [35.000, 35.001, 35.002, 35.003, 35.004].map((lat) => [139, lat]);
  const matched = [[139, 34.990], [139, 34.995], [139, 34.998], ...route];
  const reply = {
    shape: encode6(matched),
    edges: [
      { begin_shape_index: 0, begin_heading: 0, end_heading: 0, end_node: { intersecting_edges: [] } },
      { begin_shape_index: 3, begin_heading: 0, end_heading: 0,
        end_node: { intersecting_edges: [{ begin_heading: 20, driveability: "forward", road_class: "trunk" }] } },
      { begin_shape_index: 5, begin_heading: 340, end_heading: 340, end_node: { intersecting_edges: [] } },
    ],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => reply });
  try {
    assert.deepStrictEqual(await forkSides(encode6(route), "motorcycle", [2], "http://x"),
                           [{ begin: 2, end: 2, side: "left" }]);
    // 分岐から離れた所（経路の線の0番）には付けない
    assert.deepStrictEqual(await forkSides(encode6(route), "motorcycle", [0], "http://x"), []);
  } finally {
    globalThis.fetch = original;
  }
});

// MARK: 実際の Valhalla で

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`Valhalla が居ない（${BASE}）`);
// 新座（国道254号の南）→ 所沢方面（浦和所沢バイパスの西）
const NIIZA = [139.5560, 35.8060];
const TOKOROZAWA_SIDE = [139.5205, 35.8205];

test("新座の国道254号から浦和所沢バイパスへの分岐は左", async (t) => {
  if (await skipIfDown(t)) return;
  const r = await routeWithValhalla(NIIZA, TOKOROZAWA_SIDE, { displacement: "large" });
  assert.ok(!r.error, r.error);
  const forks = r.steps.filter((x) => x.valhallaType === 17);
  assert.deepStrictEqual(forks.map((x) => x.roadNames[0]), ["浦和所沢バイパス"],
                         "材料が悪い: 浦和所沢バイパスへの分岐を通っていない");
  assert.strictEqual(forks[0].forkSide, "left");
  // ほかの指示には付けない
  assert.deepStrictEqual(r.steps.filter((x) => x.valhallaType !== 17 && x.forkSide !== undefined), []);
});

test("地図に合わせ直して番号がずれても左右を付ける（新座駅の北から所沢へ）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 番号で突き合わせていたとき、ここでは左右が付かなかった（指示103・辺104）。
  //    新座の南から引くと偶然番号がそろい、検査も配信前の確かめも通っていた
  for (const [from, to] of [[[139.566, 35.793], [139.469, 35.799]],     // 新座→所沢
                            [[139.566, 35.793], [139.486, 35.925]]]) {  // 新座→川越
    const r = await routeWithValhalla(from, to, { displacement: "large" });
    assert.ok(!r.error, r.error);
    const forks = r.steps.filter((x) => x.valhallaType === 17 && /浦和所沢バイパス/.test(x.roadName));
    assert.strictEqual(forks.length, 1, "材料が悪い: 浦和所沢バイパスへの分岐を通っていない");
    assert.strictEqual(forks[0].forkSide, "left", `${from}→${to}`);
  }
});

test("近道の確かめと、種類17の無い経路では /trace_attributes を増やさない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 近道の確かめは経路1本につき何度も呼ぶ。種類17はまれ（下道72経路で1件）
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (String(url).endsWith("/trace_attributes") && /intersecting_edge/.test((init || {}).body || "")) asked.push(url);
    return original(url, init);
  };
  try {
    const quick = await routeWithValhalla(NIIZA, TOKOROZAWA_SIDE, { displacement: "large", withRoadClass: false });
    assert.ok(!quick.error, quick.error);
    const forks = quick.steps.filter((x) => x.valhallaType === 17);
    assert.strictEqual(forks.length, 1, "材料が悪い: 分岐を通っていない");
    assert.strictEqual(forks[0].forkSide, undefined);
    assert.strictEqual(asked.length, 0, "近道の確かめで左右を測っている");

    const plain = await routeWithValhalla(NIIZA, [139.6000, 35.8000], { displacement: "large" });
    assert.ok(!plain.error, plain.error);
    assert.ok(plain.steps.length > 3 && !plain.steps.some((x) => x.valhallaType === 17),
              "材料が悪い: 種類17を通っている");
    assert.strictEqual(asked.length, 0, "種類17の無い経路で左右を測っている");
  } finally {
    globalThis.fetch = original;
  }
});
