"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * おすすめ道路の調整ツールで、選んだ道をまとめて手直しする（road-builder.html の `bulkEdit`・`togglePick`・`renderBulk`）。
 *
 * 利用者の要望（2026-10-12）:「おすすめ道路 調整ツールで選択して一気に非表示などしたい」。
 * ⚠️ 1本ずつの編集（`apply`）と同じ置き場所・同じ決まりで書くこと。
 *    足した道は `state.added`、生成した道は `state.overrides`。生成した道の調整が空になったら消す。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

function fn(name) {
  const src = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(src, `${name} を取り出せない`);
  return src[0];
}

/** 画面の関数を、DOM の代わりの入れ物で動かす */
function load({ segments = [], added = [], overrides = {}, addedHome = {}, visible } = {}) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || { id, value: "", innerHTML: "" });
  const state = {
    segments, overrides, added: addedHome, checked: new Set(), lastPick: null,
    visible: visible || [...segments, ...added], dirty: 0, selected: null,
  };
  const calls = { render: 0, editor: 0, status: [] };
  const PRESET_TAGS = ["scenic", "winding"];
  const make = new Function("state", "$", "calls", "PRESET_TAGS", "addedList", `
    ${fn("overrideKey")}
    ${fn("isEmptyEdit")}
    const addedSegments = () => addedList;
    const setDirty = (n) => { state.dirty = n; };
    const setStatus = (t) => { calls.status.push(t); };
    const render = () => { calls.render++; };
    const renderEditor = () => { calls.editor++; };
    const escapeHtml = (s) => String(s);
    const tagLabel = (t) => t;
    ${fn("bulkEdit")}
    ${fn("togglePick")}
    ${fn("renderBulk")}
    return { bulkEdit, togglePick, renderBulk, overrideKey };
  `);
  return { ...make(state, $, calls, PRESET_TAGS, added), state, els, calls, $ };
}

const seg = (name, lat, extra = {}) => ({ name, start: [lat, 135], ...extra });

test("選んだ道だけをまとめて非表示にし、選んでいない道は触らない", () => {
  const a = seg("県道1号", 35.1), b = seg("県道2号", 35.2), c = seg("県道3号", 35.3);
  const t = load({ segments: [a, b, c] });
  const list = [a, b, c].map((s) => ({ seg: s }));
  t.state.checked = new Set([t.overrideKey(a), t.overrideKey(c)]);
  t.renderBulk(list);
  t.els.bulkHide.onclick();
  assert.deepStrictEqual(t.state.overrides[t.overrideKey(a)], { hidden: true });
  assert.deepStrictEqual(t.state.overrides[t.overrideKey(c)], { hidden: true });
  assert.strictEqual(t.state.overrides[t.overrideKey(b)], undefined, "選んでいない道まで非表示にした");
  assert.strictEqual(t.state.dirty, 2, "保存していない印が付かない");
});

test("まとめて手直ししても、その道に既にある調整（形・札・表示名）を落とさない", () => {
  // ⚠️ `apply` で一度あった不具合（作り直して shape が消えた）を、まとめての方で繰り返さない
  const a = seg("林道", 35.1);
  const t = load({ segments: [a] });
  const key = t.overrideKey(a);
  t.state.overrides[key] = { shape: "abc", tags: ["scenic"], title: "名", boost: 3 };
  t.state.checked = new Set([key]);
  t.bulkEdit((o) => ({ ...o, hidden: true }));
  assert.deepStrictEqual(t.state.overrides[key],
    { shape: "abc", tags: ["scenic"], title: "名", boost: 3, hidden: true });
});

test("表示に戻して調整が空になった生成した道は、控えから消す（足した道は消さない）", () => {
  // ⚠️ 足した道は名前と形が本体。空だからと消すと道そのものが消える
  const a = seg("県道1号", 35.1);
  const x = seg("手で足した道", 35.5, { added: true });
  const t = load({ segments: [a], added: [x] });
  const ka = t.overrideKey(a), kx = t.overrideKey(x);
  t.state.overrides[ka] = { hidden: true };
  t.state.added[kx] = { hidden: true, shape: "zz", name: "手で足した道" };
  t.state.checked = new Set([ka, kx]);
  t.renderBulk([{ seg: a }, { seg: x }]);
  t.els.bulkShow.onclick();
  assert.ok(!(ka in t.state.overrides), "空になった調整が残っている");
  assert.strictEqual(t.state.added[kx].hidden, false);
  assert.strictEqual(t.state.added[kx].shape, "zz", "足した道を消した");
  assert.ok(!(kx in t.state.overrides), "足した道の調整を overrides に入れた（配信でどこにも当たらない）");
});

test("札をまとめて付ける・外す（重ねて付けない・ほかの札は残す）", () => {
  const a = seg("県道1号", 35.1), b = seg("県道2号", 35.2);
  const t = load({ segments: [a, b] });
  const ka = t.overrideKey(a), kb = t.overrideKey(b);
  t.state.overrides[ka] = { tags: ["winding"] };
  t.state.overrides[kb] = { tags: ["scenic"] };
  t.state.checked = new Set([ka, kb]);
  t.renderBulk([{ seg: a }, { seg: b }]);
  t.$("bulkTag").value = "scenic";
  t.els.bulkTagAdd.onclick();
  assert.deepStrictEqual(t.state.overrides[ka].tags, ["winding", "scenic"]);
  assert.deepStrictEqual(t.state.overrides[kb].tags, ["scenic"], "同じ札を二重に付けた");
  t.els.bulkTagDel.onclick();
  assert.deepStrictEqual(t.state.overrides[ka].tags, ["winding"], "ほかの札まで外した");
  assert.ok(!(kb in t.state.overrides), "札を外して空になった調整が残っている");
});

test("Shift で、前に押した行からここまでを選ぶ（起点は鍵で覚える）", () => {
  const segs = [1, 2, 3, 4, 5].map((n) => seg("道" + n, 35 + n / 10));
  const t = load({ segments: segs });
  const k = segs.map(t.overrideKey);
  t.togglePick(1, false, true);
  t.togglePick(3, true, true);
  assert.deepStrictEqual([...t.state.checked].sort(), [k[1], k[2], k[3]].sort());
  // Shift なしは1行だけ
  t.togglePick(0, false, true);
  assert.ok(t.state.checked.has(k[0]) && !t.state.checked.has(k[4]));
  // 外すときも範囲で外せる
  t.togglePick(3, true, false);
  assert.deepStrictEqual([...t.state.checked], [], "範囲で外せていない");
  // ⚠️ 並べ替えで行の番号が変わっても、起点は同じ道
  t.togglePick(1, false, true);            // 道2 を起点に
  t.state.visible = [segs[4], segs[3], segs[2], segs[1], segs[0]];  // 逆順に並べ替え
  t.togglePick(1, true, true);             // 道4（新しい1行目）まで
  assert.deepStrictEqual([...t.state.checked].sort(), [k[1], k[2], k[3]].sort(),
    "並べ替えのあとで別の範囲を選んだ");
});

test("見えなくなった道（絞り込み・非表示にして消えた）は選んだままにしない", () => {
  // ⚠️ 残すと、見えていない道まで次の手直しに巻き込む
  const a = seg("県道1号", 35.1), b = seg("県道2号", 35.2);
  const t = load({ segments: [a, b] });
  t.state.checked = new Set([t.overrideKey(a), t.overrideKey(b)]);
  t.renderBulk([{ seg: a }]);
  assert.deepStrictEqual([...t.state.checked], [t.overrideKey(a)]);
  assert.ok(/1件を選択/.test(t.els.bulk.innerHTML));
});

test("表示中をすべて選ぶ／選んでいなければボタンを押せない", () => {
  const a = seg("県道1号", 35.1), b = seg("県道2号", 35.2), c = seg("県道3号", 35.3);
  const t = load({ segments: [a, b, c] });
  t.renderBulk([{ seg: a }, { seg: b }]);
  assert.ok(/id="bulkHide" disabled/.test(t.els.bulk.innerHTML), "選んでいないのに押せる");
  t.els.bulkAll.onchange({ target: { checked: true } });
  assert.deepStrictEqual([...t.state.checked].sort(), [t.overrideKey(a), t.overrideKey(b)].sort(),
    "表示していない道まで選んだ／表示中を選べていない");
  t.renderBulk([{ seg: a }, { seg: b }]);
  assert.ok(!/id="bulkHide" disabled/.test(t.els.bulk.innerHTML));
  assert.ok(/id="bulkAll" checked/.test(t.els.bulk.innerHTML));
  t.els.bulkClear.onclick();
  assert.strictEqual(t.state.checked.size, 0);
});

test("県を切り替えたら選んだ道を外す", () => {
  // ⚠️ 別の県の道をまとめて手直ししない
  const src = html.match(/async function loadPrefecture\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(src, "loadPrefecture を取り出せない");
  assert.ok(/state\.checked = new Set\(\)/.test(src[0]), "県を切り替えても選んだ道が残る");
});

test("一覧の行にチェックがあり、押しても道の編集は開かない", () => {
  const src = fn("render");
  assert.ok(/class="pick"/.test(src), "行にチェックが無い");
  assert.ok(/e\.stopPropagation\(\)/.test(src), "チェックを押すと行の選択（編集）まで開く");
  assert.ok(/renderBulk\(list\)/.test(src), "まとめての欄を描き直していない");
});

test("「札なし」は札が1つも無い道だけ（非表示にした道は出さない）", () => {
  // 利用者の要望（2026-10-12）:「札が付いていないものだけを表示する」
  const isUntagged = new Function(`${fn("isUntagged")}; return isUntagged;`)();
  assert.strictEqual(isUntagged({}), true);
  assert.strictEqual(isUntagged({ tags: [] }), true);
  assert.strictEqual(isUntagged({ tags: [], title: "名", boost: 3 }), true, "札以外の調整があると札なしに出ない");
  assert.strictEqual(isUntagged({ tags: ["scenic"] }), false, "札がある道を札なしに出した");
  assert.strictEqual(isUntagged({ hidden: true }), false, "非表示にした道まで札なしに出した");
  const src = fn("render");
  assert.ok(/state\.filter === "untagged"\) list = list\.filter\(\(r\) => isUntagged\(r\.o\)\)/.test(src),
    "一覧の絞り込みに札なしが無い");
  assert.ok(/data-filter="untagged"/.test(html), "札なしのボタンが無い");
});
