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
  assert.ok(/\.\.\.\((home|state\.overrides)\[key\] \|\| \{\}\)/.test(src[0]),
            "形を入れるときに他の調整を落としている:\n" + src[0]);
  // ⚠️ 足した道は `state.added` が本体。`overrides` に書くと配信に載らない
  assert.ok(/seg\.added \? state\.added/.test(src[0]),
            "足した道の形を overrides に書いている（配信に載らない）:\n" + src[0]);
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

// MARK: CSV（グリッドデータ）の道を地図に出す

/**
 * ⚠️ 2点をつなぐやり方は **CSV に道が無いと失敗する**（能登の百海七尾線で
 *    「間の道がCSVにありません」になった）。どこに道があるのか見えないまま
 *    地図をクリックすることになっていたので、**あるものを地図に描く**。
 */
test("CSVの道は、見えている範囲だけ・上限を決めて描く", () => {
  // ⚠️ 全部いっぺんに描くと固まる。北海道は6,012本ある
  const src = html.match(/async function drawCsvRoads\(\) \{[\s\S]*?\n\}/);
  assert.ok(src, "drawCsvRoads を取り出せない");
  assert.ok(/getBounds\(\)/.test(src[0]), "見えている範囲で絞っていない");
  assert.ok(/CSV_DRAW_LIMIT/.test(src[0]), "描く本数に上限が無い（多い県で固まる）");

  const limit = html.match(/const CSV_DRAW_LIMIT = (\d+);/);
  assert.ok(limit, "上限が定数になっていない");
  assert.ok(Number(limit[1]) <= 1000, `上限が大きすぎる（${limit[1]}本）`);
});

test("やめたらCSVの線と待ち受けを片付ける", () => {
  // ⚠️ 線が残ると、おすすめの線と見分けが付かなくなる。
  //    idle の待ち受けが残ると、地図を動かすたびに描き直され続ける
  const src = html.match(/function cancelAddRoad\(\) \{[\s\S]*?\n\}/);
  assert.ok(src, "cancelAddRoad を取り出せない");
  assert.ok(/clearCsvLines\(\)/.test(src[0]), "CSVの線を消していない");
  assert.ok(/removeListener\(state\.csvIdle\)/.test(src[0]), "idle の待ち受けを外していない");
});

test("CSVの索引は県ごとに1回だけ読む", () => {
  // ⚠️ 北海道は776KB・6,012本。地図を動かすたびに取り直すと重い
  const src = html.match(/async function loadCsvRoads\(\) \{[\s\S]*?\n\}/);
  assert.ok(src, "loadCsvRoads を取り出せない");
  assert.ok(/state\.csvRoadsRomaji === state\.romaji/.test(src[0]),
            "県ごとの控えを見ていない（毎回取り直す）");
});

test("道の種類の絞り込みに「すべて」がある", () => {
  // ⚠️ 「すべて」を外すと、絞ったまま探して「CSVに無い」と誤解する
  const src = html.match(/const CSV_KINDS = \[[\s\S]*?\];/);
  assert.ok(src, "CSV_KINDS を取り出せない");
  assert.ok(/\["all", *"すべて"\]/.test(src[0]), "「すべて」の選択肢が無い");

  // 索引に実在する7種類が揃っていること（全県を数えて確認した種類）
  for (const k of ["primary", "secondary", "tertiary", "trunk",
                   "unclassified", "residential", "motorway"]) {
    assert.ok(src[0].includes(`"${k}"`), `索引にある種類が選べない: ${k}`);
  }
});

test("絞り込みは地図と名前検索の両方に効く", () => {
  // ⚠️ 片方だけ効くと「地図に無いのに一覧に出る」ことになる
  const draw = html.match(/async function drawCsvRoads\(\) \{[\s\S]*?\n\}/);
  const find = html.match(/async function findCsvRoads\(\) \{[\s\S]*?\n\}/);
  assert.ok(draw && find, "drawCsvRoads / findCsvRoads を取り出せない");
  assert.ok(/matchesCsvKind/.test(draw[0]), "地図に絞り込みが効いていない");
  assert.ok(/matchesCsvKind/.test(find[0]), "名前検索に絞り込みが効いていない");

  const match = html.match(/function matchesCsvKind\(road\) \{[\s\S]*?\n\}/);
  assert.ok(match, "matchesCsvKind を取り出せない");
  const fn = new Function("state", match[0] + "; return matchesCsvKind;");
  assert.strictEqual(fn({ csvKind: "all" })({ highway: "motorway" }), true, "「すべて」で弾いている");
  assert.strictEqual(fn({ csvKind: "motorway" })({ highway: "motorway" }), true);
  assert.strictEqual(fn({ csvKind: "motorway" })({ highway: "primary" }), false, "絞れていない");
});

// MARK: CSVの線に点を出して、区間を切り出す

test("点は選んだ1本にだけ、間引いて出す", () => {
  // ⚠️ 全部の道に出すと 1本40点×500本＝2万個の印になり、地図が固まる。
  //    長い道は数千点あるので間引く（`handleIndices`）
  const src = html.match(/function showCsvPoints\(road\) \{[\s\S]*?\n\}/);
  assert.ok(src, "showCsvPoints を取り出せない");
  assert.ok(/handleIndices\(/.test(src[0]), "点を間引いていない（長い道で選べない）");
  assert.ok(/clearCsvPoints\(\)/.test(src[0]), "前の道の点を消していない（重なって残る）");
});

test("同じ道の2点なら経路探索を通さない", () => {
  // ⚠️ つなぐやり方は CSV の道路網が繋がっていないと失敗する
  //    （能登の百海七尾線で実際に失敗した）。1本の中を切るだけなら必ず成功する。
  const src = html.match(/function pickCsvPoint\(road, index\) \{[\s\S]*?\n\}\n/);
  assert.ok(src, "pickCsvPoint を取り出せない");
  assert.ok(!/fetch\(/.test(src[0]), "区間を切るのに通信している（失敗しうる）");
  assert.ok(/road\.pts\.slice\(/.test(src[0]), "線を切り出していない");
  // 同じ点を2回選んだら断ること
  assert.ok(/to - from < 1/.test(src[0]), "同じ点を通している（0mの線になる）");
});

test("やめたら点も片付ける", () => {
  const src = html.match(/function cancelAddRoad\(\) \{[\s\S]*?\n\}/);
  assert.ok(src, "cancelAddRoad を取り出せない");
  assert.ok(/clearCsvPoints\(\)/.test(src[0]), "点を消していない（地図に残る）");
});

test("切り出したときは元の道の長さを出さない", () => {
  // ⚠️ 17.6km の道から 7.4km を切り出したのに「17.6km」と出すと、
  //    実際の線と食い違ったまま登録される
  const src = html.match(/function useCsvRoad\(road, \{[\s\S]*?\n\}/);
  assert.ok(src, "useCsvRoad を取り出せない");
  assert.ok(/shapeLengthKm\(road\.polyline\)/.test(src[0]),
            "元データの lengthMeters をそのまま出している");
});
