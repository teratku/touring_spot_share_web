"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 画面（road-builder.html）が組み立てる「評価の突き合わせキー」が、
 * アプリ側（EnjoyableRoadsService.groupKey / RoadReviewStore.documentID）と
 * 同じ式になっているか。
 *
 * ⚠️ ここがずれると評価が1件も当たらない。しかも**エラーは出ず黙って空になる**ので、
 *    「まだ誰も評価していないのだろう」と勘違いしたまま気付けない。
 *
 * アプリ側の式（Swift）:
 *   groupKey  … ref があれば "r:\(県)|\(番号)|\(種別)"、無ければ "n:\(県)|\(名前)|\(種別)"
 *   documentID … その文字列の "/" を "_" に置き換えたもの
 *   県名      … 区間ID の頭（"埼玉県:0" → "埼玉県"）
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const match = html.match(/function reviewKey\(seg\) \{[\s\S]*?\n\}/);

function browserReviewKey(seg, prefName = "") {
  const fn = new Function("state", `${match[0]}; return reviewKey;`)({ prefName });
  return fn(seg);
}

test("画面側に reviewKey がある", () => {
  assert.ok(match, "road-builder.html から reviewKey を取り出せない");
});

test("路線番号があれば r: のキーになる", () => {
  assert.strictEqual(
    browserReviewKey({ id: "埼玉県:0", ref: "361", name: "三沢坂本線", highway: "secondary" }),
    "r:埼玉県|361|secondary");
});

test("路線番号が無ければ n: のキーになる", () => {
  assert.strictEqual(
    browserReviewKey({ id: "埼玉県:12", ref: "", name: "白鳥通り", highway: "primary" }),
    "n:埼玉県|白鳥通り|primary");
});

test("路線番号の前後の空白は落とす", () => {
  // アプリ側も trimmingCharacters(in: .whitespaces) している
  assert.strictEqual(
    browserReviewKey({ id: "栃木県:3", ref: " 120 ", name: "日本ロマンチック街道", highway: "primary" }),
    "r:栃木県|120|primary");
  assert.strictEqual(
    browserReviewKey({ id: "栃木県:4", ref: "   ", name: "いろは坂", highway: "secondary" }),
    "n:栃木県|いろは坂|secondary");
});

test("スラッシュはアンダースコアに置き換える", () => {
  // Firestore が ID に "/" を許さないので、アプリ側が同じ置き換えをしている
  assert.strictEqual(
    browserReviewKey({ id: "山梨県:7", ref: "", name: "山中湖/道志みち", highway: "primary" }),
    "n:山梨県|山中湖_道志みち|primary");
  assert.strictEqual(
    browserReviewKey({ id: "山梨県:8", ref: "139/138", name: "富士みち", highway: "trunk" }),
    "r:山梨県|139_138|trunk");
});

test("県名は区間IDの頭から取る", () => {
  // ⚠️ ファイルの見出し（prefName）ではなく区間ID を使う。アプリも同じ取り方をしている
  assert.strictEqual(
    browserReviewKey({ id: "群馬県:5", ref: "18", name: "碓氷バイパス", highway: "trunk" }, "埼玉県"),
    "r:群馬県|18|trunk");
});

test("区間IDが無いときだけ県名の見出しに頼る", () => {
  assert.strictEqual(
    browserReviewKey({ ref: "20", name: "甲州街道", highway: "trunk" }, "東京都"),
    "r:東京都|20|trunk");
});

test("同じ道の複数区間は同じキーになる", () => {
  // 生成データでは1本の道が複数区間に分かれる。評価は道に対して1つなので、
  // 区間が違ってもキーは一致しなければならない
  const a = { id: "埼玉県:10", ref: "209", name: "小鹿野影森停車場線", highway: "secondary" };
  const b = { id: "埼玉県:11", ref: "209", name: "小鹿野影森停車場線", highway: "secondary" };
  assert.strictEqual(browserReviewKey(a), browserReviewKey(b));
});

test("実データで作ったキーにスラッシュが残らない", () => {
  const file = path.join(__dirname, "..", "data", "road-recommend", "saitama.json");
  if (!fs.existsSync(file)) return;   // 未生成の環境では飛ばす
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const seg of data.segments) {
    const key = browserReviewKey(seg, data.prefecture);
    assert.ok(!key.includes("/"), `Firestore が受け付けないキー: ${key}`);
    assert.ok(key.startsWith("r:") || key.startsWith("n:"), `形が違う: ${key}`);
  }
});
