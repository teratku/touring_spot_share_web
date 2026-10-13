"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const SP = require("../../public/spot-points.js");

/**
 * スポットのおすすめポイント（札）を Web でも出し、札で探す（利用者の要望 2026-10-13）。
 * spot-points.js はアプリの SpotPoint・SpotSearch の写し
 */
const pub = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "public", f), "utf8");
const SWIFT = path.join(process.env.HOME || "", "Documents/Xcode/biketeilen_iOS_clean/touringSpotShare/saveRoute/SpotPoint.swift");

test("鍵の並びと表示名がアプリの SpotPoint と同じ", { skip: !fs.existsSync(SWIFT) && "アプリのソースが無い" }, () => {
  // ⚠️ 鍵は Firestore に保存されている。片方だけ変えると、付けた札が Web で消える
  const src = fs.readFileSync(SWIFT, "utf8");
  const keys = src.match(/case ([a-z, ]+)\n/)[1].split(",").map((s) => s.trim());
  assert.deepStrictEqual(SP.POINTS.map((p) => p.key), keys);
  for (const p of SP.POINTS) {
    const m = src.match(new RegExp(`case \\.${p.key}:\\s+return NSLocalizedString\\("([^"]+)"`));
    assert.ok(m, p.key);
    assert.strictEqual(p.label, m[1], `${p.key} の表示名がアプリと違う`);
  }
});

test("保存された鍵から読む（アプリの順・知らない鍵は落とす）", () => {
  assert.deepStrictEqual(SP.fromKeys(["sea", "onsen", "未来の札", "scenic"]).map((p) => p.key), ["scenic", "onsen", "sea"]);
  assert.deepStrictEqual(SP.fromKeys(undefined), [], "古い投稿（points が無い）で落ちる");
  assert.deepStrictEqual(SP.fromKeys("onsen"), []);
});

test("文字の検索は名前・コメント・住所・タグ・そばの道・札の表示名で探す", () => {
  const spot = {
    location_name: "展望台", comment: "夕日がきれい", administrative: "栃木県", locality: "日光市",
    tag: ["紅葉", ""], road: { name: "いろは坂", ref: "120" }, points: ["onsen"],
  };
  for (const q of ["展望", "夕日", "栃木", "日光", "紅葉", "いろは", "120", "温泉"]) {
    assert.ok(SP.matchesQuery(spot, q), `「${q}」で見つからない`);
  }
  assert.ok(!SP.matchesQuery(spot, "海"), "関係ない言葉で当たった");
  assert.ok(SP.matchesQuery(spot, "  "), "空の言葉で絞った");
  assert.ok(SP.matchesQuery({ location_name: "ABC" }, "abc"), "大文字・小文字を区別した");
  assert.ok(!SP.matchesQuery({ road: { name: "  " } }, "道"), "名前の無い道を拾った");
  // ⚠️ 詳細に「近くの道: 」と空の行を出さない
  assert.strictEqual(SP.roadOf({ road: { name: "  " } }), null, "名前の無い道を、そばの道として出す");
  assert.strictEqual(SP.roadOf({}), null);
  assert.strictEqual(SP.roadOf({ road: { name: "いろは坂" } }).name, "いろは坂");
});

test("札は「どれかが付いている」スポット・何も選ばなければ全部", () => {
  const s = { points: ["onsen", "cafe"] };
  assert.ok(SP.matchesPoints(s, []));
  assert.ok(SP.matchesPoints({}, []), "札の無い古い投稿を、何も選んでいないのに外した");
  assert.ok(SP.matchesPoints(s, ["sea", "cafe"]), "どれか1つ当たれば出す");
  assert.ok(!SP.matchesPoints(s, ["sea"]));
  assert.ok(!SP.matchesPoints({}, ["sea"]), "札の無い投稿を札で拾った");
});

/** index.html の Vue のメソッドを取り出して、偽の this で動かす */
function indexMethods() {
  const html = pub("index.html");
  const grab = (name) => {
    const m = html.match(new RegExp(`\\n(\\s*)${name}\\(\\) \\{[\\s\\S]*?\\n\\1\\}`));
    assert.ok(m, `index.html から ${name} を取り出せない`);
    return new Function(`return { ${m[0].trim()} }.${name};`)();
  };
  return { performSearch: grab("performSearch"), isFiltering: grab("isFiltering"), clearPoints: grab("clearPoints") };
}

function fakeApp(locations) {
  const m = indexMethods();
  const app = {
    locations, searchQuery: "", selectedRegion: "all", selectedPoints: [], filteredLocations: [],
    displayedLocations: [], mapInitialized: false, regionCalls: 0, allCalls: 0,
    loadMoreSearchResults() { this.displayedLocations = this.filteredLocations.slice(); },
    loadMoreDisplayedLocations() { this.allCalls++; },
    performRegionFilter() { this.regionCalls++; },
    createMarkers() {},
  };
  app.performSearch = m.performSearch.bind(app);
  app.isFiltering = m.isFiltering.bind(app);
  app.clearPoints = m.clearPoints.bind(app);
  return app;
}

test("トップの検索: 札だけ選んでも絞り込む（文字が空でも全部を出さない）", () => {
  global.window = { TSSSpotPoints: SP };
  try {
    const a = { id: "a", administrative: "栃木県", points: ["onsen"] };
    const b = { id: "b", administrative: "群馬県", points: ["cafe"] };
    const c = { id: "c", administrative: "栃木県" };
    const app = fakeApp([a, b, c]);
    app.selectedPoints = ["onsen"];
    app.performSearch();
    assert.deepStrictEqual(app.filteredLocations.map((l) => l.id), ["a"]);
    assert.ok(app.isFiltering(), "札だけ選んだときに「絞っていない」とみなす（地図が全部のスポットを描く）");
    // 札と地域と文字を一緒に
    app.selectedPoints = ["onsen", "cafe"];
    app.selectedRegion = "関東";
    app.searchQuery = "群馬";
    app.performSearch();
    assert.deepStrictEqual(app.filteredLocations.map((l) => l.id), ["b"]);
    // 文字だけ: アプリと同じ顔ぶれ（札の表示名でも当たる）
    app.selectedPoints = []; app.selectedRegion = "all"; app.searchQuery = "カフェ";
    app.performSearch();
    assert.deepStrictEqual(app.filteredLocations.map((l) => l.id), ["b"], "札の表示名で探せない");
    // 札を外すと全部に戻る
    app.searchQuery = ""; app.selectedPoints = ["onsen"]; app.performSearch();
    const before = app.allCalls;
    app.clearPoints();
    assert.deepStrictEqual(app.selectedPoints, []);
    assert.strictEqual(app.allCalls, before + 1, "札を外しても絞ったまま");
    assert.ok(!app.isFiltering());
  } finally { delete global.window; }
});

test("トップの検索中かどうかの判定は1か所（地図・続きの読み込みが同じ判定を使う）", () => {
  const html = pub("index.html");
  assert.ok(!/searchQuery\.trim\(\) \|\| this\.selectedRegion !== 'all'\)/.test(html),
    "札を数えない古い判定が残っている（札だけ選ぶと地図や続きの読み込みが全部のスポットに戻る）");
  assert.strictEqual((html.match(/this\.isFiltering\(\)/g) || []).length, 3);
  assert.ok(/v-for="p in spotPointOptions"/.test(html), "札を選ぶ欄が無い");
  assert.ok(/this\.applySearchFromUrl\(\)/.test(html), "スポット詳細の札から来た条件を読まない");
});

test("スポット詳細に札・そばの道・タグを出し、押すとトップで探す", () => {
  const html = pub("detail.html");
  assert.ok(/<script src="\/spot-points\.js\?v=\d+"><\/script>/.test(html), "spot-points.js を読んでいない");
  assert.ok(html.indexOf("spot-points.js") < html.indexOf("createApp"), "Vue より後に読んでいる");
  assert.ok(/v-for="p in spotPoints"/.test(html), "おすすめポイントを出していない");
  assert.ok(/v-if="spotRoad"/.test(html), "そばの道を出していない");
  assert.ok(/v-for="t in spotTags"/.test(html), "タグを出していない");
  assert.ok(/'\/\?point=' \+ encodeURIComponent\(p\.key\)/.test(html), "札を押してもトップで探せない");
  assert.ok(/v-if="spotPoints\.length \|\| spotRoad \|\| spotTags\.length"/.test(html), "空の欄を出す（古い投稿）");
});
