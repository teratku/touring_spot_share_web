"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { applyOverrides, overrideKey, normalizeOverride,
        isEmptyOverride, reshape } = require("../lib/roadOverrides");
const { encode, decode } = require("../lib/polyline");

/**
 * 登録済みの道を手で切り詰めたり延ばしたりする（形の上書き）。
 *
 * ⚠️ **形だけ差し替えてはいけない。** 「6.0km・曲率123」と出したまま実際は3kmの線、
 *    という嘘が配信される。距離・曲率・点数まで測り直すこと。
 */

/** 北へ 0.0002 度ずつ進むまっすぐな道（約22m間隔） */
function straight(count, lat0 = 36.0, lng0 = 139.0) {
  return [...Array(count)].map((_, i) => [lng0, lat0 + i * 0.0002]);   // [lng, lat]
}

/** 曲がりくねった道 */
function winding(count, lat0 = 36.0, lng0 = 139.0) {
  return [...Array(count)].map((_, i) =>
    [lng0 + (i % 2 ? 0.0006 : -0.0006), lat0 + i * 0.0002]);
}

function segmentOf(points, extra = {}) {
  const p = decode(encode(points));
  return {
    id: "テスト県:0", name: "試験道路", ref: "1", highway: "secondary",
    lengthKm: 99, curviness: 999, flow: 9, turnCount: 9, score: 50,
    polyline: encode(points), pointCount: p.length,
    start: [p[0][1], p[0][0]], end: [p[p.length - 1][1], p[p.length - 1][0]],
    ...extra,
  };
}

test("形を変えたら距離も測り直す", () => {
  const seg = segmentOf(straight(100));            // 約2.2km
  const half = encode(straight(50));

  const out = reshape(seg, half);

  assert.ok(out.lengthKm > 0.9 && out.lengthKm < 1.3, "距離が測り直されていない: " + out.lengthKm);
  assert.notStrictEqual(out.lengthKm, seg.lengthKm);
});

test("形を変えたら曲率と点数も測り直す", () => {
  // ⚠️ まっすぐな道に差し替えたのに「曲率999」のままでは、一覧の並びが嘘になる
  const seg = segmentOf(winding(100), { curviness: 999, score: 90 });

  const out = reshape(seg, encode(straight(100)));

  assert.ok(out.curviness < 100, "曲率が元のまま: " + out.curviness);
  assert.notStrictEqual(out.score, seg.score, "点数が測り直されていない");
});

test("start と end は [緯度, 経度] で入れる", () => {
  // ⚠️ decode が返すのは [経度, 緯度]。取り違えると調整の鍵が別の場所を指し、
  //    次の生成で調整が当たらなくなる（エラーは出ない）
  const seg = segmentOf(straight(50));

  const out = reshape(seg, encode(straight(50)));

  assert.ok(out.start[0] > 20 && out.start[0] < 50, "緯度の位置に経度が入っている: " + out.start);
  assert.ok(out.start[1] > 120 && out.start[1] < 155, "経度の位置に緯度が入っている: " + out.start);
});

test("先頭を残して切り詰めれば、調整の鍵は変わらない", () => {
  // ⚠️ 鍵は「道路名＠始点」。始点が動くと、いま保存した調整が次の生成で外れる
  const seg = segmentOf(straight(100));
  const before = overrideKey(seg);

  const out = reshape(seg, encode(straight(40)));

  assert.strictEqual(overrideKey(out), before, "切り詰めただけで鍵が変わった");
});

test("形と点数の加算は両方効く", () => {
  // ⚠️ **満点近い道で試さないこと。** 点数は100で頭打ちなので、
  //    加算そのものではなく打ち切りを見ることになる（重みの配り直しで
  //    満点が 85 → 100 に伸びたとき、実際にそうなって落ちた）
  const seg = segmentOf(straight(100));
  const key = overrideKey(seg);
  const shape = encode(straight(50));

  const shapedOnly = applyOverrides([seg], { [key]: { shape } }).segments[0];
  const withBoost = applyOverrides([seg], { [key]: { shape, boost: 10 } }).segments[0];

  // ⚠️ 加算は「直したあとの点数」に足す。逆にすると切り詰めで下がったぶんに食われる
  assert.ok(Math.abs(withBoost.score - (shapedOnly.score + 10)) < 0.2,
            `${shapedOnly.score} + 10 のはずが ${withBoost.score}`);
});

test("壊れた線を渡しても元のまま（落とさない）", () => {
  const seg = segmentOf(straight(50));
  for (const broken of ["", "x", "??"]) {
    const out = reshape(seg, broken);
    assert.strictEqual(out.lengthKm, seg.lengthKm, `"${broken}" で形が壊れた`);
  }
});

test("形だけの調整も「空」とみなさない", () => {
  // ⚠️ 空とみなすと保存時に捨てられ、切り詰めがファイルに残らない
  assert.strictEqual(isEmptyOverride({ shape: "abc" }), false);
  assert.strictEqual(isEmptyOverride({}), true);
});

test("形は文字列のときだけ受ける", () => {
  assert.strictEqual(normalizeOverride({ shape: 123 }).shape, null);
  assert.strictEqual(normalizeOverride({ shape: "  " }).shape, null);
  assert.strictEqual(normalizeOverride({ shape: " abc " }).shape, "abc");
});

test("形を変えていない調整は今までどおり", () => {
  // ⚠️ 既存の調整（点数・表示名・札）の動きを変えないこと
  const seg = segmentOf(straight(100), { score: 50 });
  const key = overrideKey(seg);

  const out = applyOverrides([seg], { [key]: { boost: 5, title: "別名", tags: ["絶景"] } }).segments[0];

  assert.strictEqual(out.score, 55);
  assert.strictEqual(out.title, "別名");
  assert.strictEqual(out.polyline, seg.polyline, "形を触っていないのに線が変わった");
  assert.strictEqual(out.lengthKm, seg.lengthKm);
});

// MARK: 画面側（切り詰めの範囲決め）

const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const nearestMatch = html.match(/function nearestIndex\(points, at\) \{[\s\S]*?\n\}/);

test("画面側に nearestIndex がある", () => {
  assert.ok(nearestMatch, "road-builder.html から nearestIndex を取り出せない");
});

const nearestIndex = new Function(`${nearestMatch[0]}; return nearestIndex;`)();
const line = (n) => [...Array(n)].map((_, i) => ({ lat: 36.0 + i * 0.001, lng: 139.0 }));

test("クリックした場所に一番近い点を選ぶ", () => {
  const points = line(100);
  assert.strictEqual(nearestIndex(points, { lat: 36.05, lng: 139.0 }), 50);
  assert.strictEqual(nearestIndex(points, { lat: 36.0, lng: 139.0 }), 0);
  assert.strictEqual(nearestIndex(points, { lat: 36.099, lng: 139.0 }), 99);
});

test("線から離れた場所でも一番近い点を返す", () => {
  // ⚠️ 地図のクリックは線の上に正確には落ちない。外れても近い点を選べること
  const points = line(100);
  assert.strictEqual(nearestIndex(points, { lat: 36.05, lng: 139.01 }), 50);
});

test("切り詰めても線の向きは変わらない", () => {
  // ⚠️ 2回目のクリックが1回目より手前でも、線が逆向きにならないこと
  const points = line(100);
  const [a, b] = [70, 30];
  const [from, to] = a <= b ? [a, b] : [b, a];
  const kept = points.slice(from, to + 1);
  assert.ok(kept[0].lat < kept[kept.length - 1].lat, "線が逆向きになっている");
  assert.strictEqual(kept.length, 41);
});

// MARK: 線の上に出す掴める点

const handleMatch = html.match(/function handleIndices\(count, max = MAX_HANDLES\) \{[\s\S]*?\n\}/);

test("画面側に handleIndices がある", () => {
  assert.ok(handleMatch, "road-builder.html から handleIndices を取り出せない");
});

const handleIndices = new Function(`const MAX_HANDLES = 40; ${handleMatch[0]}; return handleIndices;`)();

test("点が少ない線は全部に印を出す", () => {
  assert.deepStrictEqual(handleIndices(5), [0, 1, 2, 3, 4]);
  assert.strictEqual(handleIndices(40).length, 40);
});

test("点が多い線は間引く", () => {
  // ⚠️ 300点に300個の印を出すと地図が埋まって道が見えない
  const out = handleIndices(300);
  assert.ok(out.length <= 41, "間引けていない: " + out.length);
});

test("両端は必ず出す", () => {
  // ⚠️ 端が出ないと「端ちょうどまで残す」が指せず、必ず余るか足りないかになる
  for (const n of [2, 7, 41, 300, 1234]) {
    const out = handleIndices(n);
    assert.strictEqual(out[0], 0, `${n}点で先頭が無い`);
    assert.strictEqual(out[out.length - 1], n - 1, `${n}点で終端が無い`);
  }
});

test("同じ番号を重ねて出さない", () => {
  for (const n of [3, 41, 300]) {
    const out = handleIndices(n);
    assert.strictEqual(new Set(out).size, out.length, `${n}点で重複がある`);
  }
});

test("番号は小さい順に並ぶ", () => {
  const out = handleIndices(300);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1] < out[i], "並びが崩れている");
  }
});

test("点が無い線でも落ちない", () => {
  assert.deepStrictEqual(handleIndices(0), []);
  assert.deepStrictEqual(handleIndices(1), [0]);
});

test("点数は100で頭打ち", () => {
  // ⚠️ 上の試験が打ち切りを見ないよう分けてある。打ち切り自体はここで見る
  const seg = segmentOf(winding(100));
  const key = overrideKey(seg);
  const shape = encode(winding(100));
  const boosted = applyOverrides([seg], { [key]: { shape, boost: 50 } }).segments[0];
  assert.ok(boosted.score <= 100, `100 を超えている: ${boosted.score}`);
});
