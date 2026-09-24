"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { forkSide, routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * 種類17（分岐を直進）で、経路が左右どちらの道へ分かれるか。
 *
 * ⚠️ **数字は実際の `/trace_attributes` から写した**:
 *    - 新座の国道254号（北向き・柳瀬川の橋）→ 浦和所沢バイパス: 入る向き318°、経路296°、
 *      本線（出て行ける）341°
 *    - 新大宮バイパス: 入る向き162°、経路164°、ほかは合流してくるだけの道（352°・backward）
 */
test("本線より左の道へ進むなら左（新座の国道254号→浦和所沢バイパス）", () => {
  assert.strictEqual(forkSide(318, 296, [{ heading: 341, driveability: "forward" }]), "left");
  // 同じ節点に左から入ってくるだけの道があっても左（出て行けない道は比べない）
  assert.strictEqual(forkSide(318, 296, [{ heading: 341, driveability: "forward" },
                                         { heading: 280, driveability: "backward" }]), "left");
});

test("本線より右の道へ進むなら右", () => {
  assert.strictEqual(forkSide(318, 341, [{ heading: 296, driveability: "forward" }]), "right");
  assert.strictEqual(forkSide(318, 341, [{ heading: 296, driveability: "both" }]), "right");
  // 右から交わる道があっても右の分岐（交わる道は比べない）
  assert.strictEqual(forkSide(318, 341, [{ heading: 296, driveability: "forward" },
                                         { heading: 48, driveability: "both" }]), "right");
});

test("向きが0°をまたいでも左右を取り違えない", () => {
  // 北を挟む: 入る350°、経路330°（左へ20°）、本線10°（右へ20°）
  assert.strictEqual(forkSide(350, 330, [{ heading: 10, driveability: "forward" }]), "left");
  assert.strictEqual(forkSide(10, 30, [{ heading: 350, driveability: "forward" }]), "right");
});

test("出て行けない道は分かれ道に数えない（新大宮バイパス）", () => {
  // ⚠️ 合流してくるだけの道しか無い所は、分かれ道ではない。左右を言わない
  assert.strictEqual(forkSide(162, 164, [{ heading: 352, driveability: "backward" }]), null);
  assert.strictEqual(forkSide(162, 164, [{ heading: 190, driveability: "backward" }]), null);
  assert.strictEqual(forkSide(162, 164, []), null);
  // 同じ向きでも、出て行けるなら分かれ道
  assert.strictEqual(forkSide(162, 164, [{ heading: 190, driveability: "forward" }]), "left");
});

test("横から交わる道は分かれ道に数えない", () => {
  // 経路は左へ22°、右から75°で交わる道だけ → 分かれ道ではない
  assert.strictEqual(forkSide(318, 296, [{ heading: 33, driveability: "both" }]), null);
  // 60°までは分かれ道
  assert.strictEqual(forkSide(318, 296, [{ heading: 18, driveability: "both" }]), "left");
});

test("3つに分かれる真ん中は左右を言わない", () => {
  assert.strictEqual(forkSide(0, 0, [{ heading: 340, driveability: "forward" },
                                     { heading: 20, driveability: "forward" }]), null);
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
