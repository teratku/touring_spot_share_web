"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * 画面の「走らせて案内を聞く」まわり。
 *
 * ⚠️ **音そのものはここでは確かめられない**（Web Speech API はブラウザにしか無い）。
 *    確かめるのは「配線が生きているか」と「文言を画面側で作っていないか」。
 */
const FILE = path.join(__dirname, "..", "public", "valhalla.html");
const html = fs.readFileSync(FILE, "utf8");

/** src の付いていない `<script>` の中身（＝実際に走るコード） */
function inlineScripts() {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

test("画面のコードが構文として通る", () => {
  // ⚠️ 途中で1文字壊すと、それ以降の配線が丸ごと死ぬ。エラーは画面にしか出ない
  for (const [i, code] of inlineScripts().entries()) {
    assert.doesNotThrow(() => new vm.Script(code),
      `${i} 番目の script が構文で落ちる`);
  }
});

test("配線を `<script src=…>` の中に置いていない", () => {
  // ⚠️ **実際にやった。** `</script>` を末尾から探して差し込んだところ、
  //    Google マップのローダー（`<script async src=…>`）の中に入ってしまい、
  //    **中身が丸ごと無視されて**ボタンが一切効かなくなった。
  //    しかもエラーは出ないので、原因に辿り着くまで時間がかかる
  const re = /<script[^>]*\bsrc=[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    assert.strictEqual(m[1].trim(), "",
      `src 付きの script に中身が入っている（無視される）: ${m[1].trim().slice(0, 80)}`);
  }
});

test("走らせるための部品が画面にある", () => {
  for (const id of ["driveRun", "driveSpeed", "driveVoice", "driveVoiceName",
                    "driveTry", "driveNow", "driveLog", "driveAt",
                    "annFar", "annNear", "annImminent", "annLong"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} が画面に無い`);
  }
});

test("配線が、部品の定義より後に置かれている", () => {
  // ⚠️ **const より前で呼ぶと「Cannot access before initialization」で丸ごと止まる。**
  //    実際に踏んだ（`loadVoices()` が `const voice` より前にあった）
  const declaredAt = html.indexOf("const voice = {");
  const usedAt = html.indexOf("loadVoices();\n");
  assert.ok(declaredAt > 0 && usedAt > 0, "目印が見つからない");
  assert.ok(usedAt > declaredAt,
    "loadVoices() の呼び出しが const voice の宣言より前にある");
});

test("読み上げの文言を画面側で作っていない", () => {
  // ⚠️ **文言はサーバー（`lib/navGuide.js`）にだけ置く。** アプリと同じ規則を
  //    二重に持つと必ずずれる。画面は返ってきた `text` を出すだけ。
  //    ⚠️ **例外は試聴の見本の1文だけ**（実測: いま画面にある言い回しはこれ1つ）。
  //       増えていたら、画面で組み立て始めた合図
  const code = inlineScripts().join("\n");
  const SAMPLE = "700メートル先、甲府警察署東交差点を城東通りへ左折です";
  const withoutSample = code.split(SAMPLE).join("");
  for (const phrase of ["メートル先、", "まもなく", "をあと", "キロ先、",
                        "左折です", "右折です", "直進します", "道なりに"]) {
    assert.ok(!withoutSample.includes(phrase),
      `画面側で「${phrase}」を組み立てている（サーバーに寄せること）`);
  }
  assert.ok(code.includes(SAMPLE), "試聴の見本が消えている（材料が変わった）");
});

test("案内は窓口から取る", () => {
  const code = inlineScripts().join("\n");
  assert.ok(code.includes("/api/nav/guidance"),
    "画面が案内の窓口を叩いていない");
});

// MARK: 走る日時

test("走る日時を決める欄がある", () => {
  for (const id of ["useRideAt", "rideAt", "rideHoliday"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} が画面に無い`);
  }
  // ⚠️ **祝日はこちらでは判らない。** 祝日の一覧を持っていないので人に渡してもらう
  assert.ok(/祝日/.test(html), "祝日の指定が画面に無い");
});

test("決めていなければ日時を渡さない", () => {
  // ⚠️ **空の `at` や「いま」を勝手に渡してはいけない。** サーバー側は `at` があると
  //    「その時刻に効いている規制だけ避ける」に切り替わる。走る時刻が分からないのに
  //    「いまは通れる」と決めるより、避けすぎるほうが安全。
  //    ⚠️ 実際に走らせて確かめる。文字列を探すだけだと、別の行に当たって空振りする
  const code = inlineScripts().join("\n");
  const m = code.match(/function rideWhen\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, "rideWhen が無い");

  const boxes = { useRideAt: { checked: false }, rideAt: { value: "" },
                  rideHoliday: { checked: false } };
  const run = new Function("document", `${m[0]}\nreturn rideWhen();`);
  const doc = { getElementById: (id) => boxes[id] };

  assert.deepStrictEqual(run(doc), {}, "決めていないのに日時を渡している");

  boxes.useRideAt.checked = true;
  assert.deepStrictEqual(run(doc), {}, "日時が空なのに渡している");

  boxes.rideAt.value = "2026-08-29T09:00";
  boxes.rideHoliday.checked = true;
  const got = run(doc);
  assert.ok(got.at, "決めたのに日時を渡していない");
  assert.strictEqual(got.isHoliday, true, "祝日の指定が渡っていない");
});

test("日時を経路の依頼に混ぜている", () => {
  const code = inlineScripts().join("\n");
  assert.ok(/\.\.\.rideWhen\(\)/.test(code), "依頼に日時を混ぜていない");
});

test("避けきれなかった規制を、画面に出している", () => {
  // ⚠️ **出さないと、規制の上を通る経路がふつうの経路にしか見えない。**
  //    窓口は返しているのに画面が捨てていた（実際にそうなっていた）
  const html = fs.readFileSync(
    require("path").join(__dirname, "..", "public", "valhalla.html"), "utf8");
  assert.ok(/restrictionHits/.test(html), "避けきれなかった規制を読んでいない");
  assert.ok(/規制の上を通る/.test(html), "避けきれなかった規制の見出しが無い");
  // ⚠️ exclude_polygons は周囲の合計 10,000m まで。超えたぶんは落としている
  assert.ok(/restrictionSkipped/.test(html), "塞げなかった規制を読んでいない");
  assert.ok(/塞げない/.test(html), "塞げなかった規制の見出しが無い");
  // 何件ぶつかったかだけでなく、どの規制かを出す
  assert.ok(/h\.name \|\| h\.id/.test(html), "どの規制かを出していない（件数だけ）");

  // ⚠️ **組み立てただけでは出ない。** 表示する文字列に繋がっているか確かめる
  //    （文言を作っておいて `right` に足し忘れる、という抜け方をする）
  // ⚠️ 手前に置き場所だけの `right = ...—...` があるので、そこを掴まないこと
  //    （掴むと定義そのものを数えてしまい、足し忘れを見逃す）
  const at = html.indexOf("right = `<span class=\"num\">${(r.lengthMeters");
  assert.ok(at > 0, "経路のまとめを組み立てている場所が見つからない");
  const built = html.slice(at, html.indexOf("el.innerHTML", at));
  assert.ok(!built.includes("const hitText"), "切り出す範囲が広すぎる（定義を含んでいる）");
  for (const name of ["hitText", "overText"]) {
    assert.ok(built.includes(name), `${name} を表示に足していない（作っただけ）`);
  }
});

test("位置情報の書き出しが画面にある", () => {
  // ⚠️ **配線だけでは出ない。** 一度、JS は入れたのにボタンの HTML を入れ忘れ、
  //    「窓口は動くのに画面に何も無い」状態になった（実際にそうなった）
  assert.ok(/id="gpx"/.test(html), "GPX のボタンが無い");
  assert.ok(/id="gpxPts"/.test(html), "simctl のボタンが無い");
  assert.ok(/id="gpxSpeed"/.test(html), "走る速さの指定が無い");
  const code = inlineScripts().join("\n");
  assert.ok(/getElementById\("gpx"\)\.onclick/.test(code), "GPX のボタンが配線されていない");
  assert.ok(/getElementById\("gpxPts"\)\.onclick/.test(code), "simctl のボタンが配線されていない");
  // ⚠️ 書式の組み立てはサーバでやる（端末の makeGpx.js と2か所に分けない）
  assert.ok(/\/api\/valhalla\/gpx/.test(code), "サーバの窓口を使っていない");
  assert.ok(!/<wpt lat=/.test(code), "画面で GPX を組み立てている");
});
