"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { isEmptyOverride } = require("../lib/roadOverrides");

/**
 * 区間の手直しで、編集欄の内容を控えに反映する処理（road-builder.html の `apply`）。
 *
 * 【なぜこのファイルがあるか】
 * ⚠️ 実機で「おすすめ道路の道を変更したとき、保存できているときとできていない時がある」
 *    と報告された。原因は `apply()` が控えを**作り直していた**こと。
 *    編集欄が扱う5項目（非表示・加算・表示名・ひとこと・札）だけで組み立てるので、
 *    **手で直した形（`shape`）が黙って消えていた**。
 *
 *    形だけ直したときは残り、そのあと札や表示名を触った瞬間に消えるので、
 *    「できているときとできていない時がある」ように見えた。
 *
 * ⚠️ さらに「空の調整なら消す」判定にも `shape` が入っておらず、
 *    形だけ直した道は**触った瞬間に控えごと消えていた**。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

/** 画面側の `isEmptyEdit` を取り出す */
function loadIsEmptyEdit() {
  const src = html.match(/function isEmptyEdit\(o\) \{[\s\S]*?\n\}/);
  assert.ok(src, "isEmptyEdit を取り出せない");
  return new Function(`${src[0]}; return isEmptyEdit;`)();
}

test("空かどうかの判定に形が入っている", () => {
  const isEmptyEdit = loadIsEmptyEdit();
  // ⚠️ ここが抜けていたのが不具合の片方。形だけ直した道が「空」とみなされて消えた
  assert.strictEqual(isEmptyEdit({ shape: "abc" }), false,
                     "形だけ直した調整を「空」とみなしている（消える）");
  assert.strictEqual(isEmptyEdit({}), true);
  assert.strictEqual(isEmptyEdit({ tags: [] }), true);
  for (const o of [{ hidden: true }, { boost: 5 }, { title: "名" }, { note: "説明" }, { tags: ["絶景"] }]) {
    assert.strictEqual(isEmptyEdit(o), false, JSON.stringify(o) + " を「空」とみなしている");
  }
});

test("空の判定がサーバ側と揃っている", () => {
  // ⚠️ 片方だけ直すと、画面では残っているのに保存で消える（またはその逆）になる
  const isEmptyEdit = loadIsEmptyEdit();
  const cases = [
    {}, { shape: "abc" }, { hidden: true }, { boost: 3 }, { title: "名" },
    { note: "説明" }, { tags: ["絶景"] }, { tags: [] }, { boost: 0, tags: [] },
  ];
  for (const o of cases) {
    assert.strictEqual(isEmptyEdit(o), isEmptyOverride(o),
      `画面とサーバで判定が違う: ${JSON.stringify(o)}`
      + `（画面${isEmptyEdit(o)} / サーバ${isEmptyOverride(o)}）`);
  }
});

test("編集欄は控えを作り直さず、既にある項目を引き継ぐ", () => {
  // ⚠️ **これが報告された不具合そのもの。** 以前は5項目だけで作り直しており、
  //    形を直したあとに札を触ると `shape` が消えた。
  //    値では捕まえられない（画面の関数は DOM を読む）ので、**引き継いでいるか**を見る。
  const src = html.match(/function apply\(\) \{[\s\S]*?\n\}/);
  assert.ok(src, "apply を取り出せない");
  // ⚠️ 引き継ぎ元は `home`（生成した道なら overrides、足した道なら added）。
  //    どちらであれ「既にあるものを広げてから上書き」の形になっていること
  assert.ok(/\.\.\.\((home|state\.overrides)\[key\] \|\| \{\}\)/.test(src[0]),
            "既にある調整を引き継いでいない（形の直しが消える）:\n" + src[0]);
  // 5項目だけを並べた素朴な作り直しに戻っていないこと
  assert.ok(!/const next = \{\s*\n\s*hidden:/.test(src[0]),
            "控えを作り直している（引き継ぎが無い）");
});

test("形を直すところも既にある調整を引き継ぐ", () => {
  // ⚠️ 逆向きの取り違え。形を入れるときに札や加算を落とさないこと
  const src = html.match(/function setShape\(seg, encoded\) \{[\s\S]*?\n\}/);
  assert.ok(src, "setShape を取り出せない");
  assert.ok(/\.\.\.\(state\.overrides\[key\] \|\| \{\}\)/.test(src[0]),
            "形を入れるときに他の調整を落としている:\n" + src[0]);
});

test("再生成したあと、足した道が一覧に二重に出ない", () => {
  // ⚠️ **これが報告された不具合。** 足した道は生成を回すと配信データに混ざるので、
  //    次に画面を開くと `state.segments` にも同じ道が入っている。
  //    `state.added` からも出すと一覧に2行並ぶ。
  //    生成側（`applyOverrides` の `existingKeys`）と同じ規則で揃える。
  const src = html.match(/function addedSegments\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(src, "addedSegments を取り出せない");
  assert.ok(/existing\.has\(key\)/.test(src[0]),
            "生成データに同じ道があるかを見ていない（二重に出る）:\n" + src[0]);

  const addedSegments = new Function(
    "state", "overrideKey", "decodePolyline",
    src[0] + "; return addedSegments;")(
      // 生成データに既に入っている道と、まだ入っていない道
      { segments: [{ name: "既に配信済み", start: [36.0, 139.0] }],
        added: {
          "既に配信済み@36.00,139.00": { name: "既に配信済み", shape: "x" },
          "まだの道@35.00,138.00": { name: "まだの道", shape: "y" },
        },
        measured: {} },
      (s) => `${s.name}@${(Math.round(s.start[0] / 0.01) * 0.01).toFixed(2)},`
             + `${(Math.round(s.start[1] / 0.01) * 0.01).toFixed(2)}`,
      () => [{ lat: 35.0, lng: 138.0 }, { lat: 35.1, lng: 138.1 }]);

  const names = addedSegments().map((s) => s.name);
  assert.deepStrictEqual(names, ["まだの道"],
    "配信データに入っている道を重ねて出している: " + JSON.stringify(names));
});
