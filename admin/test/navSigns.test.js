"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { towardNames } = require("../lib/navName");
const { routeWithValhalla, BASE } = require("../lib/valhallaRoute");

/**
 * 標識の「〇〇方面」を取り出すところ。
 *
 * ⚠️ **材料は手で作らない。** 高速を通る6区間で Valhalla が実際に返した応答
 *    （`fixtures-nav-signs.json`。作り直しは admin で `node makeSignFixtures.js`）。
 */
const FIX = path.join(__dirname, "fixtures-nav-signs.json");
const fixtures = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, "utf8")) : null;
const skipIfNoFixture = (t) => (fixtures ? false : t.skip("材料が無い環境"));
const all = () => Object.values(fixtures.区間).flatMap((r) => r.maneuvers);
const rawToward = (m) => ((m.sign && m.sign.exit_toward_elements) || []).map((e) => e.text);
const withToward = () => all().filter((m) => rawToward(m).length > 0);
const LATIN_ONLY = /^[\x20-\x7e]+$/;

test("方面の付いた指示から、名前が必ず取れる", (t) => {
  if (skipIfNoFixture(t)) return;
  const list = withToward();
  assert.ok(list.length >= 10, `材料が悪い: 方面つきの指示が ${list.length} 件しかない`);
  for (const m of list) {
    assert.ok(towardNames(m).length > 0, `取りこぼし: ${m.instruction}`);
  }
});

test("方面の無い指示は空で返す", (t) => {
  if (skipIfNoFixture(t)) return;
  const none = all().filter((m) => rawToward(m).length === 0);
  assert.ok(none.length > 50, "材料が悪い: 方面の無い指示が少ない");
  for (const m of none) assert.deepStrictEqual(towardNames(m), []);
  // 壊れた形でも落ちないこと
  assert.deepStrictEqual(towardNames(null), []);
  assert.deepStrictEqual(towardNames({ sign: {} }), []);
  assert.deepStrictEqual(towardNames({ sign: { exit_toward_elements: [{}, { text: "" }] } }), []);
});

test("前後の空白を落とす（実データに ' Enzan' がある）", (t) => {
  if (skipIfNoFixture(t)) return;
  const spaced = withToward().filter((m) => rawToward(m).some((x) => x !== x.trim()));
  assert.ok(spaced.length > 0, "材料が悪い: 空白の付いた名前が無い");
  for (const m of spaced) {
    for (const name of towardNames(m)) {
      assert.strictEqual(name, name.trim(), `空白が残っている: "${name}"`);
    }
  }
  assert.ok(withToward().some((m) => towardNames(m).includes("Enzan")),
    "空白を落とした名前が取れていない");
});

test("重なりを落とし、並び順は Valhalla のまま", (t) => {
  if (skipIfNoFixture(t)) return;
  for (const m of withToward()) {
    const got = towardNames(m);
    assert.strictEqual(new Set(got).size, got.length, `重なっている: ${got}`);
    // ⚠️ 先頭ほど標識の主な行き先。並べ替えると読む2つが変わる
    const order = got.map((n) => rawToward(m).findIndex((x) => x.trim() === n));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
      `並びが変わった: ${rawToward(m)} → ${got}`);
    // 取りこぼしが無いこと
    const distinct = new Set(rawToward(m).map((x) => x.trim()).filter(Boolean));
    assert.strictEqual(got.length, distinct.size, `落とした名前がある: ${rawToward(m)} → ${got}`);
  }
});

test("同じ名前が二度来ても一度だけ返す（念のための守り）", () => {
  // ⚠️ **実データでは起きていない**（46区間・方面つき227件で0件）。
  //    そのため材料からは確かめられず、ここだけ手で作った入力で押さえる。
  //    空白違いの同じ名前（' 横浜' と '横浜'）は、空白を落とした後に重なる
  const m = { sign: { exit_toward_elements: [
    { text: "横浜" }, { text: " 横浜" }, { text: "静岡" }, { text: "横浜" },
  ] } };
  assert.deepStrictEqual(towardNames(m), ["横浜", "静岡"]);
});

test("英字の名前も残す（読むかどうかはアプリが言語で決める）", (t) => {
  if (skipIfNoFixture(t)) return;
  const latin = withToward().flatMap(towardNames).filter((n) => LATIN_ONLY.test(n));
  const ja = withToward().flatMap(towardNames).filter((n) => !LATIN_ONLY.test(n));
  assert.ok(ja.length > 10, "材料が悪い: 日本語の名前が少ない");
  assert.ok(latin.length > 0, "英字の名前を落としている（英語の利用者が困る）");
});

test("名前の中の「方面」はここでは削らない（削るのは読み上げ側）", (t) => {
  if (skipIfNoFixture(t)) return;
  const names = withToward().flatMap(towardNames);
  assert.ok(names.some((n) => n.endsWith("方面")),
    "材料が悪い、または削っている: 「〇〇方面」という名前が無い");
});

// ─── 実際に動いている Valhalla で ───

async function up() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (e) { return false; }
}

test("経路の指示ひとつひとつに方面の欄が載る", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  // 東京 → 甲府。下道でも、バイパスの出入口に方面が付く（実測4件）
  const r = await routeWithValhalla([139.7671, 35.6812], [138.5684, 35.6664]);
  assert.ok(!r.error, r.error);
  for (const s of r.steps) {
    assert.ok(Array.isArray(s.towardNames), `方面の欄が無い指示がある: ${s.instruction}`);
    // ⚠️ アプリが出口の見分けに使う。消さないこと
    assert.strictEqual(typeof s.valhallaType, "number", "Valhalla の種類番号が無い");
  }
  const named = r.steps.filter((s) => s.towardNames.length > 0);
  assert.ok(named.length > 0, "方面がひとつも載っていない（捨てている）");
});
