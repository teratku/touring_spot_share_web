"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { overrideKey } = require("../lib/roadOverrides");

/**
 * 画面（road-builder.html）と Node（lib/roadOverrides.js）で
 * 調整の鍵の作り方が一致しているか。
 *
 * ⚠️ ここがずれると、画面で保存した調整が生成時に当たらなくなる。
 *    しかもエラーにならず「調整したのに反映されない」という形で出るので気付きにくい。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const match = html.match(/function overrideKey\(seg\) \{[\s\S]*?\n\}/);

test("画面側に overrideKey がある", () => {
  assert.ok(match, "road-builder.html から overrideKey を取り出せない");
});

test("画面と Node で鍵が一致する", () => {
  const browserKey = new Function(`${match[0]}; return overrideKey;`)();
  const cases = [
    { name: "いろは坂", start: [36.7512, 139.4873] },
    { name: "ビーナスライン", start: [36.1034, 138.1926] },
    { name: "国道1号", start: [35.0, 135.0] },
    { name: "境界ちょうど", start: [36.755, 139.495] },
    { name: "負の丸め", start: [36.7549, 139.4949] },
    { name: "桁の多い値", start: [43.062096, 141.354376] },
    { name: "沖縄の道", start: [26.2124, 127.6809] },
    { name: "名前に@が入る道@変", start: [35.5, 139.5] },
  ];
  for (const c of cases) {
    assert.strictEqual(browserKey(c), overrideKey(c), `${c.name} で鍵が違う`);
  }
});

test("鍵は道路名を保つ（@ を含む名前でも壊れない）", () => {
  const key = overrideKey({ name: "変な@名前", start: [35.5, 139.5] });
  // parseKey は最後の @ で切るので、名前に @ があっても復元できる
  const { applyOverrides } = require("../lib/roadOverrides");
  const seg = { name: "変な@名前", score: 50, start: [35.5, 139.5], end: [35.6, 139.5] };
  const out = applyOverrides([seg], { [key]: { boost: 10 } });
  assert.strictEqual(out.segments[0].score, 60);
});
