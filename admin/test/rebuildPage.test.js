"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * 二普協由来の規制を JARTIC で作り直す画面。
 *
 * ⚠️ 地図そのものは node では確かめられない。ここで押さえるのは
 *    **配線が生きていること**と、**機械で決めさせない作りになっていること**。
 */
const FILE = path.join(__dirname, "..", "public", "rebuild.html");
const html = fs.readFileSync(FILE, "utf8");
const inlineScripts = () => {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
};
const code = inlineScripts().join("\n");

test("画面のコードが構文として通る", () => {
  for (const [i, c] of inlineScripts().entries()) {
    assert.doesNotThrow(() => new vm.Script(c), `${i} 番目の script が構文で落ちる`);
  }
});

test("配線を `<script src=…>` の中に置いていない", () => {
  // ⚠️ 一度やった。src 付きの script に中身を入れると丸ごと無視され、
  //    エラーも出ないまま画面が動かなくなる
  const re = /<script[^>]*\bsrc=[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) assert.strictEqual(m[1].trim(), "", "src 付きの script に中身が入っている");
});

test("線を5桁で読む", () => {
  // ⚠️ 6桁で読むと座標が10分の1になって地図の外へ飛ぶ（`lib/polyline.js` は5桁）
  assert.ok(/1e5/.test(code), "5桁で読んでいない");
  assert.ok(!/1e6/.test(code), "6桁で読んでいる（10倍ずれる）");
});

test("登録済みの線と候補の線を、両方描く", () => {
  // ⚠️ **見比べられなければ判断できない。** 片方だけ描いても意味が無い
  assert.ok(/it\.registered\.polyline/.test(code), "いま登録されている線を描いていない");
  assert.ok(/c\.points\.map/.test(code), "JARTIC の候補の線を描いていない");
  assert.ok(/#e8590c/.test(code) && /#1971c2/.test(code), "2本を色分けしていない");
});

test("重なり率だけで押させない注意を、画面に出している", () => {
  // ⚠️ **実測の裏付けがある注意。** 消すと誤って別の道に置き換える
  assert.ok(/首都圏中央連絡自動車道/.test(html), "誤マッチの実例が画面から消えている");
  assert.ok(/見比べ/.test(html), "地図で見比べるよう促していない");
});

test("置き換えを画面から組み立てさせない", () => {
  // ⚠️ 県ぶんの配列を画面から PUT させると、表示していない規制を巻き添えで消しうる。
  //    入れ替えはサーバー側（`/api/rebuild/:romaji/promote`）でやる
  assert.ok(/\/api\/rebuild\/\$\{state\.romaji\}\/promote/.test(code),
    "サーバー側の入れ替えを呼んでいない");
  assert.ok(!/method:\s*"PUT"/.test(code), "画面から県ぶんを丸ごと上書きしている");
});

test("出典を画面に出している", () => {
  // ⚠️ **JARTIC の規約が求めている**
  assert.ok(/id="attr"/.test(html), "出典を出す場所が無い");
  assert.ok(/j\.attribution/.test(code), "取り込みファイルの出典を読んでいない");
});

test("窓口がサーバーにある", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const route of ["/api/rebuild/prefectures", "/api/rebuild/:romaji",
                       "/api/rebuild/:romaji/promote", "/api/rebuild/skip"]) {
    assert.ok(server.includes(`"${route}"`), `窓口が無い: ${route}`);
  }
  // ⚠️ 置き換えたら必ず jartic と記録する。ここが目的
  assert.ok(/origin: "jartic"/.test(server), "置き換えで出どころを記録していない");
});

test("候補の線を、登録済みの線の下に隠さない", () => {
  // ⚠️ **実際に隠れた。** 登録済みを zIndex 5・太さ7で上に置いていたので、
  //    候補（zIndex 2）が下敷きになって見比べられなかった
  // ⚠️ 手前に「選んでいないときの概観」の線があるので、そこを掴まないこと
  //    （掴むと概観の zIndex を登録済みの線として比べてしまう）
  const draw = code.slice(code.indexOf("function draw(items)"));
  const selected = draw.slice(draw.indexOf("const bounds = new google.maps.LatLngBounds();"));
  const zIndexes = [...selected.matchAll(/zIndex:\s*(?:(\w+)\s*\?\s*(\d+)\s*:\s*)?(\d+)/g)];
  assert.ok(zIndexes.length >= 2, "線の重ね順を指定していない");
  const oldZ = Number(zIndexes[0][3]);                       // 登録済み
  const candZ = zIndexes.slice(1).flatMap((m) => [Number(m[2]), Number(m[3])].filter(Number.isFinite));
  assert.ok(candZ.length, "候補の重ね順が読み取れない");
  assert.ok(Math.min(...candZ) > oldZ,
    `候補(${Math.min(...candZ)}) が登録済み(${oldZ}) の下にある`);
});

test("何も選んでいなくても、一覧ぶんの線を描く", () => {
  // ⚠️ **一覧に48件あるのに地図が真っ白だと「データが無い」ように見える**
  //    （実際にそう見えた）。選択待ちで空にしないこと
  const draw = code.slice(code.indexOf("function draw(items)"));
  const noSel = draw.slice(draw.indexOf("if (!it) {"), draw.indexOf("const bounds ="));
  assert.ok(noSel.length > 0, "選んでいないときの分岐が無い");
  assert.ok(/for \(const x of items\)/.test(noSel), "一覧ぶんを回していない");
  assert.ok(/new google\.maps\.Polyline/.test(noSel), "線を描いていない");
  assert.ok(/fitBounds/.test(noSel), "描いた範囲に寄せていない");
});

test("見送ったものも、地図で場所を見られる", () => {
  // ⚠️ **戻すかどうかは場所を見ないと決められない。** 選べないようにしてはいけない
  assert.ok(!/if \(it\.skipped\) return;/.test(code), "見送りを選べないようにしている");
  assert.ok(/x\.skipped \? "#6b7280" : "#e8590c"/.test(code), "見送りを色で見分けていない");
  // ⚠️ 県ぜんぶに寄せると1件は数ピクセル。薄いと地図が空に見える
  const overview = code.slice(code.indexOf("if (!it) {"), code.indexOf("const bounds ="));
  const w = /strokeWeight:\s*(\d+)/.exec(overview);
  const o = /strokeOpacity:\s*([\d.]+)/.exec(overview);
  assert.ok(w && Number(w[1]) >= 5, `概観の線が細い（${w && w[1]}）`);
  assert.ok(o && Number(o[1]) >= 0.8, `概観の線が薄い（${o && o[1]}）`);
  assert.ok(/見送ったもの/.test(html), "凡例に見送りの色が無い");
});
