"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  applicable, hitsOnRoute, excludePolygonsFor, boxesAround, perimeterOf, spotsAlong,
  DISPLACEMENT_CC, BLOCK_EVERY_METERS,
} = require("../lib/restrictionAvoid");
const { blocksAlways, blocksEveryone, blockedSegments, overlapRatio } = require("../lib/restrictionOverlap");
const { encode } = require("../lib/polyline");

/** 芦ノ湖スカイラインを模した、まっすぐ10kmの線（実データの長さに合わせてある） */
const LONG = Array.from({ length: 101 }, (_, i) => [139.0 + i * 0.001, 35.2]);
const R = (over = {}) => ({
  id: "r1", kind: "noMotorcycle", name: "試験道路", points: LONG,
  minCc: 0, maxCc: 99999, ...over,
});

// MARK: 誰に効くか

test("排気量で絞る", () => {
  const only50 = R({ minCc: 0, maxCc: 50 });
  assert.strictEqual(applicable([only50], { displacement: "moped50" }).length, 1);
  assert.strictEqual(applicable([only50], { displacement: "large" }).length, 0);
  // ⚠️ 排気量が分からないときは絞らない（見落としのほうが危ない）
  assert.strictEqual(applicable([only50], {}).length, 1);
});

test("通行止め以外は避けない", () => {
  // 二人乗り禁止・冬季閉鎖は条件次第で走れる。ここで避けると走れる道を消す
  assert.strictEqual(applicable([R({ kind: "noTandem" })], {}).length, 0);
  assert.strictEqual(applicable([R({ kind: "noMotorcycle" })], {}).length, 1);
});

// MARK: 時間と曜日

test("効いていない時刻は避けない", () => {
  const timed = R({ activeHours: { from: "07:00", to: "08:00" } });
  const at = (h, m = 0) => new Date(2026, 7, 28, h, m);   // 2026-08-28（金）
  assert.strictEqual(applicable([timed], { at: at(12) }).length, 0);
  assert.strictEqual(applicable([timed], { at: at(7, 30) }).length, 1);
});

test("日をまたぐ時間指定も効く", () => {
  // ⚠️ 実測で大阪に「自二輪 22:00〜06:00」がある。素朴な from<=now<to では落とす
  const night = R({ activeHours: { from: "22:00", to: "06:00" } });
  const at = (h) => new Date(2026, 7, 28, h);
  assert.strictEqual(applicable([night], { at: at(23) }).length, 1);
  assert.strictEqual(applicable([night], { at: at(3) }).length, 1);
  assert.strictEqual(applicable([night], { at: at(12) }).length, 0);
});

test("曜日の指定を見る", () => {
  // 土曜・日曜・休日（JARTIC の曜日コード2）。2026-08-28 は金曜
  const weekend = R({ activeDays: [6, 7], includesHoliday: true });
  assert.strictEqual(applicable([weekend], { at: new Date(2026, 7, 28) }).length, 0);
  assert.strictEqual(applicable([weekend], { at: new Date(2026, 7, 29) }).length, 1); // 土
  // 平日でも祝日なら効く
  assert.strictEqual(applicable([weekend],
    { at: new Date(2026, 7, 28), isHoliday: true }).length, 1);
});

test("時刻を渡さなければ、時間の判断をしない", () => {
  // ⚠️ いつ走るか分からないのに「いまは通れる」と決めてはいけない
  const timed = R({ activeHours: { from: "07:00", to: "08:00" } });
  assert.strictEqual(applicable([timed], {}).length, 1);
});

// MARK: 塞ぐ形

test("長い規制でも上限に収まる", () => {
  // ⚠️ **最初は線全体を外接四角で包んでいて、10km級で周囲21,700mになり
  //    上限10,000mを超えて丸ごと捨てられていた**（塞げていなかった）
  const rings = boxesAround(LONG);
  const total = rings.reduce((a, r) => a + perimeterOf(r), 0);
  assert.ok(rings.length >= 5, `四角が ${rings.length} 個しかない`);
  assert.ok(total < 10_000, `周囲 ${Math.round(total)}m が上限を超えている`);
});

test("四角は小さく保つ", () => {
  // ⚠️ 大きくすると、規制されていない交差道路まで巻き込む
  for (const ring of boxesAround(LONG)) {
    assert.ok(perimeterOf(ring) < 400, `1個で周囲 ${Math.round(perimeterOf(ring))}m は大きすぎる`);
  }
});

test("点々と置く（1点だけにしない）", () => {
  // ⚠️ 1点だけだと、その手前で入って手前で出る経路が残る
  const spots = spotsAlong(LONG, BLOCK_EVERY_METERS);
  assert.ok(spots.length >= 5, `${spots.length} 箇所しか置いていない`);
  const xs = spots.map((s) => s[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.05, "同じ場所に固まっている");
});

test("上限を超えるぶんは渡さず、渡せなかったと返す", () => {
  // ⚠️ 超えると Valhalla は経路ごと失敗する。黙って落とさず、残りを返す
  const many = Array.from({ length: 20 }, (_, i) => R({ id: `r${i}`, ratio: 1 }));
  const out = excludePolygonsFor(many);
  const total = out.polygons.reduce((a, r) => a + perimeterOf(r), 0);
  assert.ok(total <= 10_000, `周囲 ${Math.round(total)}m を渡そうとしている`);
  assert.ok(out.skipped.length > 0, "渡せなかったものが記録されていない");
  assert.strictEqual(out.used.length + out.skipped.length, many.length);
});

// MARK: 経路との重なり

test("経路が規制の上を通っていれば見つける", () => {
  const onIt = LONG.map(([lng, lat]) => [lng, lat + 0.00001]);   // ほぼ同じ線
  assert.strictEqual(hitsOnRoute(onIt, [R()]).length, 1);
});

test("離れた経路は見つけない", () => {
  const away = LONG.map(([lng, lat]) => [lng, lat + 0.05]);      // 約5.5km 北
  assert.strictEqual(hitsOnRoute(away, [R()]).length, 0);
});

test("点が足りないものは扱わない", () => {
  assert.deepStrictEqual(hitsOnRoute([], [R()]), []);
  assert.deepStrictEqual(hitsOnRoute([[139, 35]], [R()]), []);
  assert.strictEqual(applicable([R({ points: [[139, 35]] })], {}).length, 0);
});

// MARK: 一覧づくりとの食い違い

test("おすすめ道路の除外は、時間限定を落とさない", () => {
  // ⚠️ **ここが今回の要。** 一覧は時刻を持たないので「いつでも通れない」ものだけ落とす。
  //    実測: JARTIC の候補1,442件のうち全員が通れないもの235件、
  //    **そのうち90件が時間・曜日つき**（千葉の通学路「07:00〜08:00」など）。
  //    時間を見ずに落とすと、1日23時間走れる道が丸ごと消える
  assert.strictEqual(blocksAlways(R()), true);
  assert.strictEqual(blocksAlways(R({ activeHours: { from: "07:00", to: "08:00" } })), false);
  assert.strictEqual(blocksAlways(R({ activeDays: [6, 7] })), false);
  assert.strictEqual(blocksAlways(R({ includesHoliday: true })), false);
  assert.strictEqual(blocksAlways(R({ activeMonths: [12, 1, 2] })), false);
  // 全曜日・全月の指定は「いつでも」と同じ
  assert.strictEqual(blocksAlways(R({ activeDays: [1, 2, 3, 4, 5, 6, 7] })), true);
});

test("排気量の区切りが Node 側とそろっている", () => {
  const { DISPLACEMENT_RANGES } = require("../lib/restrictionOverlap");
  assert.deepStrictEqual(Object.values(DISPLACEMENT_CC), DISPLACEMENT_RANGES);
  assert.strictEqual(blocksEveryone(R()), true);
  assert.strictEqual(blocksEveryone(R({ minCc: 0, maxCc: 50 })), false);
});

test("時間限定の規制は、おすすめ道路から落とさない", () => {
  // ⚠️ **`blocksAlways` を直に試すだけでは足りない。** 実際に使う
  //    `blockedSegments` が見ていなければ、道は消えてしまう。
  //    実測: JARTIC の候補で「全員が通れない235件のうち90件が時間・曜日つき」
  const road = { polyline: encode(LONG), name: "試験道路" };
  const always = { ...R(), polyline: encode(LONG) };
  const timed = { ...R(), polyline: encode(LONG), activeHours: { from: "07:00", to: "08:00" } };
  const weekend = { ...R(), polyline: encode(LONG), activeDays: [6, 7] };

  assert.strictEqual(blockedSegments([always], [road]).size, 1,
    "いつでも通れない規制が落とされていない（材料が悪い）");
  assert.strictEqual(blockedSegments([timed], [road]).size, 0,
    "07:00〜08:00 だけの規制で、1日23時間走れる道をおすすめから消している");
  assert.strictEqual(blockedSegments([weekend], [road]).size, 0,
    "土日だけの規制で、平日走れる道をおすすめから消している");
});

// MARK: 経路が規制の上を走ったか（割合では測れない）

/**
 * ⚠️ **実機で報告（2026-09-20）**:「二輪禁止表示は出ているが、二輪禁止ルートを
 *    通ってしまっている」。原因は、経路の判定に**おすすめ道路と同じ割合の物差し**
 *    （`MIN_RATIO` 0.3）を使っていたこと。長い規制線を少しかすめる経路は
 *    「重なり17%」で見逃されるが、**763m も走っていた**。
 *    経路は1mでも走れば通行禁止違反なので、割合ではなく**走った距離**で見る。
 */
test("長い規制を少しだけ走る経路も見逃さない", () => {
  // 10km の規制線（東西にまっすぐ）
  const long = [];
  for (let i = 0; i <= 100; i++) long.push([139.0 + i * 0.0011, 35.0]);
  const restriction = { id: "r1", kind: "noMotorcycle", name: "長い規制",
                        polyline: encode(long) };
  const rules = applicable([restriction], {});
  assert.strictEqual(rules.length, 1, "材料が悪い: 規制が当てはまっていない");

  // 規制線の端 600m ぶんだけ重なって走り、あとは南へ離れる経路
  const route = [];
  for (let i = 0; i <= 6; i++) route.push([139.0 + i * 0.0011, 35.0]);
  for (let i = 1; i <= 40; i++) route.push([139.0066, 35.0 - i * 0.002]);

  // ⚠️ 材料の確認。割合で見ると小さく、旧の物差しでは拾えない形であること
  const ratio = overlapRatio(rules[0].points, route, 25);
  assert.ok(ratio < 0.3, `材料が悪い: 重なりが ${(ratio * 100).toFixed(0)}% で割合でも拾える`);

  const hits = hitsOnRoute(route, rules);
  assert.strictEqual(hits.length, 1,
    `走っているのに見逃している（重なり ${(ratio * 100).toFixed(0)}%）`);
  assert.ok(hits[0].runMeters > 400,
    `走った距離を測れていない: ${hits[0].runMeters}m`);
});

test("交差点で横切るだけなら規制とみなさない", () => {
  // ⚠️ **ここを拾うと、無関係な道が軒並み「規制の上」になる。**
  //    25m 以内にいる距離は、直角に横切るなら道幅ぶんにしかならない
  const long = [];
  for (let i = 0; i <= 100; i++) long.push([139.0 + i * 0.0011, 35.0]);
  const rules = applicable([{ id: "r1", kind: "noMotorcycle", name: "長い規制",
                              polyline: encode(long) }], {});
  // 南北にまっすぐ横切る経路（規制線とは1点で交わるだけ）
  const route = [];
  for (let i = -40; i <= 40; i++) route.push([139.055, 35.0 + i * 0.002]);
  assert.strictEqual(hitsOnRoute(route, rules).length, 0,
    "横切っただけの道を規制の上とみなしている");
});

test("走った距離で拾ったものも、避ける対象として使える形で返す", () => {
  // ⚠️ `excludePolygonsFor` は `points` を見る。付け忘れると塞げない
  const long = [];
  for (let i = 0; i <= 100; i++) long.push([139.0 + i * 0.0011, 35.0]);
  const rules = applicable([{ id: "r1", kind: "noMotorcycle", name: "長い規制",
                              polyline: encode(long) }], {});
  const route = [];
  for (let i = 0; i <= 6; i++) route.push([139.0 + i * 0.0011, 35.0]);
  for (let i = 1; i <= 40; i++) route.push([139.0066, 35.0 - i * 0.002]);
  const hits = hitsOnRoute(route, rules);
  assert.strictEqual(hits.length, 1, "材料が悪い");
  assert.ok(hits[0].points && hits[0].points.length >= 2, "線が付いていない（塞げない）");
  assert.ok(excludePolygonsFor(hits).polygons.length > 0, "通せんぼを作れない");
});

// MARK: 手で登録した規制が配信に載るか

/**
 * ⚠️ **実機で報告（2026-09-20）**: 県道236号（不動峠）の二輪規制がデータに無く、
 *    経路がそのまま通っていた。手で登録してもらったが、**登録画面が出どころを
 *    記録していなかった**ため `origin` が空になり、`isSellable` で外れて
 *    「一覧には出るのに経路が避けない」状態が続いた。
 */
test("登録画面が出どころを記録する", () => {
  const fs = require("fs");
  const path = require("path").join(__dirname, "..", "public", "road-builder.html");
  if (!fs.existsSync(path)) { return; }
  const html = fs.readFileSync(path, "utf8");
  assert.ok(html.includes('id="r-origin"'), "出どころを選ぶ欄が無い");
  assert.ok(html.includes("origin: $(\"r-origin\").value || null"),
    "保存するときに出どころを入れていない");
  // ⚠️ **憶測で埋めないこと。** 空のときは null のまま（「分からない」を残す）
  assert.ok(!/origin:\s*\$\("r-origin"\)\.value\s*\|\|\s*"(survey|jartic|osm|jmpsa)"/.test(html),
    "空のときに出どころを決め打ちしている（憶測で埋めない）");
  // 空で登録したときに知らせること
  assert.ok(html.includes("出どころが空です"), "出どころが空でも黙って登録している");
});

test("出どころの無い規制は配信に載らない", () => {
  const { isSellable } = require("../lib/restrictionOrigin");
  // ⚠️ ここが崩れると、転用の許諾が無いデータを売ってしまう
  assert.strictEqual(isSellable({ origin: "survey" }), true);
  assert.strictEqual(isSellable({ origin: "jartic" }), true);
  assert.strictEqual(isSellable({ origin: "osm" }), true);
  assert.strictEqual(isSellable({ origin: "jmpsa" }), false, "二普協を売ろうとしている");
  assert.strictEqual(isSellable({}), false, "出どころ不明を売ろうとしている");
  assert.strictEqual(isSellable({ origin: null }), false);
});

// MARK: 規制の配信ボタン

/**
 * ⚠️ **実機で尋ねられた（2026-09-20）**:「通行規制のタブに配信ボタンが無いため、
 *    区間の手直しの配信ボタンを押せばいい？」。押していたら**おすすめ道路**の
 *    再生成と配信が走っていた（規制とは別物）。規制専用の入口を用意する。
 */
test("規制タブから規制だけを配信できる", () => {
  const fs = require("fs");
  const path = require("path").join(__dirname, "..", "public", "road-builder.html");
  if (!fs.existsSync(path)) return;
  const html = fs.readFileSync(path, "utf8");

  assert.ok(html.includes('id="rPublishHeader"'), "規制の配信ボタンが無い");
  assert.ok(html.includes('"/api/restrictions/publish"'),
    "規制の配信が規制のエンドポイントを呼んでいない");
  // ⚠️ **規制タブでおすすめ道路の配信を押させないこと**（別のものが本番へ行く）
  assert.ok(/\$\("publish"\)\.style\.display\s*=\s*which === "restrict" \? "none"/.test(html),
    "規制タブでおすすめ道路の配信ボタンを隠していない");
  // ⚠️ **下見を挟むこと**（本番の Firestore に書き込む）
  assert.ok(html.includes("rRunPublish(false)"), "規制の下見が無い");
  assert.ok(html.includes("rPublishReady"), "下見なしで配信できてしまう");
});

test("配信モーダルの行き先が入口ごとに決まる", () => {
  const fs = require("fs");
  const path = require("path").join(__dirname, "..", "public", "road-builder.html");
  if (!fs.existsSync(path)) return;
  const html = fs.readFileSync(path, "utf8");
  // ⚠️ **開いた入口が行き先を決めること。** モーダルのボタンは共用なので、
  //    どこかで固定すると「おすすめ道路のつもりで規制を配信する」が起きる
  const assigns = html.match(/\$\("pubGo"\)\.onclick\s*=/g) || [];
  assert.strictEqual(assigns.length, 2,
    `pubGo の行き先が ${assigns.length}か所（おすすめ道路と規制の2つであること）`);
  for (const entry of ['$("publish").onclick', '$("rPublishHeader").onclick']) {
    const at = html.indexOf(entry);
    assert.ok(at > 0, `${entry} が無い`);
    const body = html.slice(at, at + 900);
    assert.ok(body.includes('$("pubGo").onclick'),
      `${entry} が行き先を入れ直していない（前に開いた入口のまま配信される）`);
  }
});
