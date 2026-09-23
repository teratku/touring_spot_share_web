"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { towardNames, exitNames, exitNumbers, branchNames } = require("../lib/navName");
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

// ─── 高速の IC・JCT の名前・出口番号・その先の道路（高速の JCT・IC 案内の第1段） ───

/** 標識の要素そのまま（生の文字） */
const rawOf = (key) => (m) => ((m.sign && m.sign[key]) || []).map((e) => e.text);
const rawName = rawOf("exit_name_elements");
const rawNumber = rawOf("exit_number_elements");
const rawBranch = rawOf("exit_branch_elements");
/** 前後の空白を落として、出てきた順に重なりなし */
const tidy = (texts) => [...new Set(texts.map((x) => (x || "").trim()).filter(Boolean))];
/** 海老名JCT（東名→圏央道の分岐）。名前・番号・分岐先・方面がそろう実例 */
const ebinaJct = () => all().find((m) => rawName(m).includes("海老名JCT"));

test("IC・JCTの名前は、英字・全角・「（仮称）」も含めて出てきた順に返す", (t) => {
  if (skipIfNoFixture(t)) return;
  const list = all().filter((m) => rawName(m).length > 0);
  assert.ok(list.length >= 10, `材料が悪い: 名前の付いた指示が ${list.length} 件しかない`);
  for (const m of list) {
    assert.deepStrictEqual(exitNames(m), tidy(rawName(m)), `取り違え・取りこぼし: ${m.instruction}`);
  }
  // ⚠️ **整えるのはアプリ**（表示と読み上げで扱いが違う）。ここで直していないことを実例で押さえる
  const got = list.map(exitNames);
  assert.ok(got.some((n) => JSON.stringify(n) === JSON.stringify(["海老名ＩＣ", "海老名IC", "Ebina IC"])),
    "全角・英字の併記を崩した（海老名IC）");
  assert.ok(got.some((n) => n.includes("大津JCT（仮称）")), "「（仮称）」をここで削っている");
  assert.ok(got.some((n) => n.includes("烏森出口")), "「〇〇出口」を落としている");
});

test("出口番号・その先の道路は、それぞれの欄から取る（名前・方面と取り違えない）", (t) => {
  if (skipIfNoFixture(t)) return;
  const jct = ebinaJct();
  assert.ok(jct, "材料が悪い: 海老名JCT の指示が無い");
  assert.deepStrictEqual(exitNames(jct), ["海老名JCT"]);
  assert.deepStrictEqual(exitNumbers(jct), ["4-2"]);
  // ⚠️ 番号と名前が混ざる。並びは標識のまま（先頭が主な道路）
  assert.deepStrictEqual(branchNames(jct), ["C4", "E20", "E84", "E1A"]);
  assert.ok(towardNames(jct).includes("八王子"), "材料が悪い: 方面が無い");
  const numbered = all().filter((m) => rawNumber(m).length > 0);
  const branched = all().filter((m) => rawBranch(m).length > 0);
  assert.ok(numbered.length >= 10 && branched.length >= 10,
    `材料が悪い: 番号 ${numbered.length} 件・その先の道路 ${branched.length} 件`);
  for (const m of all()) {
    assert.deepStrictEqual(exitNumbers(m), tidy(rawNumber(m)), `出口番号: ${m.instruction}`);
    assert.deepStrictEqual(branchNames(m), tidy(rawBranch(m)), `その先の道路: ${m.instruction}`);
  }
  // 番号と路線名が混ざる実例（京都→神戸・近畿道の分岐）
  assert.ok(branched.map(branchNames).some((b) => b.includes("E26") && b.includes("Kinki Expressway")),
    "番号と路線名が混ざった並びを崩した");
});

test("標識の無い指示・壊れた形は、どれも空で返す", () => {
  for (const f of [exitNames, exitNumbers, branchNames]) {
    assert.deepStrictEqual(f(null), [], `${f.name}: null で落ちる`);
    assert.deepStrictEqual(f({}), [], `${f.name}: 標識が無いと落ちる`);
    assert.deepStrictEqual(f({ sign: {} }), [], `${f.name}: 空の標識で落ちる`);
    assert.deepStrictEqual(f({ sign: {
      exit_name_elements: [{}, { text: "" }, { text: " " }],
      exit_number_elements: [{ text: null }],
      exit_branch_elements: [{ text: 12 }],
    } }), [], `${f.name}: 中身の無い要素を返している`);
  }
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

test("経路の指示ひとつひとつに、IC・JCTの名前・出口番号・その先の道路の欄が載る", async (t) => {
  if (!(await up())) return t.skip(`Valhalla が居ない（${BASE}）`);
  if (skipIfNoFixture(t)) return;
  // 用賀 → 厚木（東名・海老名JCT で圏央道へ分かれる所を通る）
  const { from, to } = fixtures.区間["用賀→厚木"];
  const r = await routeWithValhalla(from, to, { displacement: "large" });
  assert.ok(!r.error, r.error);
  for (const s of r.steps) {
    for (const key of ["exitNames", "exitNumbers", "branchNames"]) {
      assert.ok(Array.isArray(s[key]), `${key} の欄が無い指示がある: ${s.instruction}`);
    }
  }
  const jct = r.steps.find((s) => s.exitNames.includes("海老名JCT"));
  assert.ok(jct, "海老名JCT の名前が載っていない（捨てている）");
  assert.deepStrictEqual(jct.exitNumbers, ["4-2"], "出口番号が載っていない・取り違えている");
  assert.ok(jct.branchNames.includes("C4"), `その先の道路が載っていない: ${jct.branchNames}`);
});
