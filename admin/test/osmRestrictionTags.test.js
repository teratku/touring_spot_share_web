"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { parseConditional, toCandidateFields } = require("../lib/osmRestrictionTags");
const { stitch } = require("../lib/roadStitcher");
const { polylineLength } = require("../lib/roadCsv");

/**
 * OSM のタグを規制の形に読み替える処理の確認。
 *
 * ⚠️ ここを読み違えても**エラーにはならない**。
 *    緩く読めば走れない道がおすすめのまま残り、きつく読めば走れる道が消える。
 *    どちらも「規制がそういうものなのだろう」としか見えないので、ここで固定する。
 *
 * ⚠️ 材料は作り話ではなく、Overpass で全国を数えて実在を確かめた6通りを使っている。
 *    増やすときも、実データに無い書き方を足さないこと（守る意味が無い）。
 */

// MARK: 条件付きの読み取り

test("日曜と祝日の深夜という指定を読む", () => {
  // 大阪生駒線（51片）。暴走行為対策の規制
  const r = parseConditional("no @ (Su,PH 00:00-06:00)");
  assert.ok(r, "読めていない");
  assert.strictEqual(r.value, "no");
  assert.deepStrictEqual(r.days, [7], "日曜だけになっていない");
  assert.strictEqual(r.includesHoliday, true, "祝日（PH）を落としている");
  assert.deepStrictEqual(r.hours, { from: "00:00", to: "06:00" });
});

test("平日朝の指定を読み、裏返しの句に引きずられない", () => {
  // 旧東海道（11片）。"; Sa,Su,PH off" は前半の裏返しでしかない。
  // ⚠️ ここを拾うと「土日祝も規制」と逆の意味になる
  const r = parseConditional("no @ (Mo-Fr 07:30-09:00; Sa,Su,PH off)");
  assert.ok(r, "読めていない");
  assert.deepStrictEqual(r.days, [1, 2, 3, 4, 5], "月〜金になっていない: " + JSON.stringify(r.days));
  assert.strictEqual(r.includesHoliday, false, "off の側の PH を拾ってしまっている");
  assert.deepStrictEqual(r.hours, { from: "07:30", to: "09:00" });
});

test("日をまたぐ夜間の指定が潰れない", () => {
  // 南田中町旭町線（11片）。⚠️ from > to を「おかしな値」として捨てると、
  //    夜間規制が丸ごと終日規制になる
  const r = parseConditional("no @ (21:00-05:00)");
  assert.ok(r, "読めていない");
  assert.deepStrictEqual(r.hours, { from: "21:00", to: "05:00" },
                         "日またぎが潰れている: " + JSON.stringify(r.hours));
  assert.deepStrictEqual(r.days, [], "曜日の指定が無いのに曜日が付いている");
});

test("空白の無い書き方でも読む", () => {
  // ⚠️ "no@(...)" と詰めて書かれた実データがある。@ の前後で空白を当てにしないこと
  const r = parseConditional("no@(Su,PH 00:00-04:00)");
  assert.ok(r, "空白が無いと読めなくなっている");
  assert.deepStrictEqual(r.days, [7]);
  assert.deepStrictEqual(r.hours, { from: "00:00", to: "04:00" });
});

test("曜日の指定が無い時間だけの指定も読む", () => {
  const r = parseConditional("no @ (07:00-09:00)");
  assert.ok(r, "読めていない");
  assert.deepStrictEqual(r.hours, { from: "07:00", to: "09:00" });
});

test("時間帯が2つ並ぶ指定は読めたことにしない", () => {
  // ⚠️ `activeHours` は1区間しか持てない。片方を黙って捨てると、
  //    捨てた側の時間は「通れる」と配信することになる。読めないと言って人に回す
  assert.strictEqual(parseConditional("no @ (07:00-09:00, 17:00-19:00)"), null,
                     "2つの時間帯のうち片方だけ採ってしまっている");
});

test("読めない文字列は null", () => {
  for (const text of ["", null, undefined, "no", "ただの文字", "no @ ()"]) {
    assert.strictEqual(parseConditional(text), null,
                       JSON.stringify(text) + " を読めたことにしている");
  }
});

// MARK: タグ全体からの読み替え

test("二輪通行禁止は終日の規制になる", () => {
  const f = toCandidateFields({ highway: "tertiary", name: "白山白川郷ホワイトロード",
                                motorcycle: "no", scenic: "yes", toll: "yes" });
  assert.strictEqual(f.blocks, true, "規制として扱えていない");
  assert.strictEqual(f.kind, "noMotorcycle");
  assert.strictEqual(f.activeHours, null, "終日なのに時間が入っている");
  assert.strictEqual(f.activeDays, null, "終日なのに曜日が入っている");
  assert.strictEqual(f.minCc, null);
});

test("原付は通れると書いてあれば51cc以上が対象", () => {
  // 京都の天の橋立線（motorcycle=no / moped=yes）。
  // ⚠️ ここを見ないと、原付で走れる道まで原付ユーザーのおすすめから消える
  const f = toCandidateFields({ name: "天の橋立線", motorcycle: "no", moped: "yes" });
  assert.strictEqual(f.blocks, true);
  assert.strictEqual(f.minCc, 51, "原付が通れることを見ていない");
  assert.strictEqual(f.targetLabel, "51cc以上");
});

test("押して歩けば通れる指定では下限を付けない", () => {
  // 向野橋（moped=dismount）。降りて押す前提であって、原付で走れるわけではない
  const f = toCandidateFields({ name: "向野橋", motorcycle: "no", moped: "dismount" });
  assert.strictEqual(f.minCc, null, "dismount を「原付は通れる」と読んでいる");
});

test("車両全部が通れないなら通行止めにする", () => {
  const f = toCandidateFields({ name: "八栗牟礼線", motorcycle: "no", motor_vehicle: "no" });
  assert.strictEqual(f.kind, "closed", "二輪だけの話にしてしまっている");
});

test("用のある車は通れる指定は規制にしない", () => {
  // 富士見通り（destination @ 07:00-09:00）。
  // ⚠️ これを通行禁止として扱うと、走れる道がおすすめから消える
  const f = toCandidateFields({ name: "富士見通り",
                                "motorcycle:conditional": "destination @ 07:00-09:00" });
  assert.strictEqual(f.blocks, false, "通行禁止ではない指定を規制として扱っている");
  assert.ok(f.reason && f.reason.includes("destination"), "理由に原文が残っていない");
});

test("条件を読めなくても規制としては残し、原文を伝える", () => {
  // ⚠️ 読めないからと捨てると、通れない道が黙っておすすめに残る。
  //    かといって終日にすると通れる時間まで禁止になる。時間は空にして人に回す
  const f = toCandidateFields({ "motorcycle:conditional": "no @ (Mo-Fr 07:00-09:00, 17:00-19:00)" });
  assert.strictEqual(f.blocks, true, "読めないものを黙って捨てている");
  assert.strictEqual(f.activeHours, null, "読めていないのに時間を入れている");
  assert.ok(f.reason && f.reason.includes("17:00-19:00"), "原文が残っていない: " + f.reason);
});

test("条件付きの指定から曜日と時間が入る", () => {
  const f = toCandidateFields({ name: "旧東海道",
                                "motorcycle:conditional": "no @ (Mo-Fr 07:30-09:00; Sa,Su,PH off)" });
  assert.strictEqual(f.blocks, true);
  assert.deepStrictEqual(f.activeDays, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(f.activeHours, { from: "07:30", to: "09:00" });
  assert.strictEqual(f.includesHoliday, false);
});

test("二輪について何も書いていない道は候補にしない", () => {
  const f = toCandidateFields({ highway: "primary", name: "国道4号" });
  assert.strictEqual(f.blocks, false, "規制の指定が無い道を拾っている");
});

// MARK: 断片を1本に繋ぐ（実データ）

const fixture = path.join(__dirname, "fixtures-osm-ishikawa.json");
const ishikawa = JSON.parse(fs.readFileSync(fixture, "utf8"));

test("細切れの断片が1本の道になる", () => {
  // ⚠️ OSM の道は交差点ごとに切れている。繋がないと18.7kmの道が
  //    「300m の規制が55本」に化け、地図で確かめようがない
  const fragments = ishikawa.elements
    .filter((e) => e.tags.name)
    .map((e) => ({ prefecture: "石川県", name: e.tags.name, ref: e.tags.ref,
                   highway: e.tags.highway, osmId: String(e.id),
                   points: e.geometry.map((p) => [p.lon, p.lat]) }));

  const chains = stitch(fragments)
    .filter((c) => c.name === "白山白川郷ホワイトロード")
    .sort((a, b) => polylineLength(b.points) - polylineLength(a.points));

  assert.ok(chains.length, "ホワイトロードが1本も出ない");
  const longest = Math.round(polylineLength(chains[0].points));
  assert.ok(Math.abs(longest - 18745) < 200,
            `1本に繋がっていない（${longest}m。実測18,745m）`);
  assert.ok(chains[0].fragmentCount > 40,
            `断片をほとんど繋げていない（${chains[0].fragmentCount}片）`);
});

test("繋がらなかった短い切れ端は落とせる", () => {
  // ⚠️ 石川では10mと12mの孤立片が残る。落とさないと「12mの通行禁止」が
  //    候補に並び、確認の邪魔になる
  const fragments = ishikawa.elements
    .filter((e) => e.tags.name)
    .map((e) => ({ prefecture: "石川県", name: e.tags.name, ref: e.tags.ref,
                   highway: e.tags.highway, osmId: String(e.id),
                   points: e.geometry.map((p) => [p.lon, p.lat]) }));
  const short = stitch(fragments).filter((c) => polylineLength(c.points) < 100);
  assert.ok(short.length >= 2, "短い切れ端が出ない材料になっている（テストの意味が無い）");
});

// MARK: 県ぶんの候補を作るところまで（ネットワークは叩かない）

const { buildQuery, buildCandidates, MIN_CHAIN_METERS } = require("../fetchOsmRestrictions");

test("県の中だけを引くクエリになっている", () => {
  // ⚠️ 全国を bbox で引くと韓国が丸ごと入る（実測で1,367件中1,065件が国外）。
  //    県の area で絞れていないと、他国の道路が候補に並ぶ
  const q = buildQuery("石川県");
  assert.ok(q.includes('area["name"="石川県"]["admin_level"="4"]'), "県で絞っていない");
  assert.ok(q.includes("(area.a)"), "絞った area を使っていない");
});

test("クエリに highway の絞りを書かない", () => {
  // ⚠️ **速さの話。** highway の正規表現を入れると桁違いに遅くなる。
  //    石川県で実測: あり127.7秒 / 無し8.4秒。全国47県では2時間と8分の差になる。
  //    歩道を落とすのは `toFragments` 側の仕事（下のテストで確かめている）
  const q = buildQuery("石川県");
  assert.ok(!q.includes("highway"), "クエリに highway の絞りが入っている（遅くなる）");
});

test("歩道・自転車道は候補にしない", () => {
  // ⚠️ 二輪規制タグが付く道の大半がこれ（全国822件のほとんど）。
  //    歩行者専用なのだから二輪が入れないのは当たり前で、規制として意味が無い。
  //    ⚠️ クエリ側で絞らなくなったので、**ここで落とせているかが唯一の砦**
  const walk = ["footway", "cycleway", "path", "track", "steps"].map((highway, i) => ({
    type: "way", id: 900 + i,
    tags: { name: `歩道${i}`, highway, motorcycle: "no" },
    geometry: [...Array(8)].map((_, k) => ({ lat: 35 + k * 0.002, lon: 139 })),
  }));
  const list = buildCandidates("千葉県", "chiba", walk);
  assert.deepStrictEqual(list.map((c) => c.sourceRoad), [],
                         "歩道・自転車道が候補に混ざっている");
});

test("私道は規制として扱わない", () => {
  // ⚠️ motorcycle=private は「持ち主の許し」の話で、公安委員会の通行禁止とは別物。
  //    条件付きタグで拾った way に private が乗ってくることがある
  const f = toCandidateFields({ name: "私道",
                                motorcycle: "private",
                                "motorcycle:conditional": "no @ (21:00-05:00)" });
  assert.strictEqual(f.blocks, false, "私道を規制として登録してしまう");
});

test("石川県の応答から18.7kmの候補が1本できる", () => {
  const list = buildCandidates("石川県", "ishikawa", ishikawa.elements);
  const white = list.filter((c) => c.sourceRoad === "白山白川郷ホワイトロード");
  assert.strictEqual(white.length, 1,
                     `1本にまとまっていない（${white.length}本: `
                     + white.map((c) => c.lengthMeters + "m").join("/") + "）");
  assert.ok(Math.abs(white[0].lengthMeters - 18745) < 200,
            `長さが違う（${white[0].lengthMeters}m。実測18,745m）`);
  assert.strictEqual(white[0].kind, "noMotorcycle");
  assert.ok(white[0].polyline.length > 0, "線が空");
});

test("短い切れ端は候補にしない", () => {
  // ⚠️ 石川では10mと12mの孤立片が出る。落とさないと「12mの通行禁止」が候補に並ぶ。
  // ⚠️ **ここで `MIN_CHAIN_METERS` を使って比べないこと。** しきい値を1mに変えても
  //    テストが一緒に緩んで通ってしまう（実際にそうなっていた）。数字を直接書く
  const list = buildCandidates("石川県", "ishikawa", ishikawa.elements);
  const tooShort = list.filter((c) => c.lengthMeters < 100);
  assert.deepStrictEqual(tooShort.map((c) => `${c.sourceRoad}(${c.lengthMeters}m)`), [],
                         "短い切れ端が候補に残っている");
  assert.ok(MIN_CHAIN_METERS >= 100, `しきい値が緩んでいる（${MIN_CHAIN_METERS}m）`);
});

test("候補のidは元データの道そのものから作る", () => {
  // ⚠️ id が変わると、登録済みの規制が候補と結び付かず「登録したのに消えた」ように見える。
  // ⚠️ **並び順を変えて比べるだけでは足りない。** 通し番号（osm-ishikawa-0）でも
  //    並べ替えには耐えてしまい、道が1本増えた瞬間に全部ずれる（実際に見落とした）。
  //    id が「その道の way 番号」であること自体を確かめる
  const wayIds = new Set(ishikawa.elements.map((e) => String(e.id)));
  const list = buildCandidates("石川県", "ishikawa", ishikawa.elements);
  assert.ok(list.length, "候補が出ていない");
  for (const c of list) {
    const tail = c.id.replace(/^osm-ishikawa-/, "");
    assert.ok(wayIds.has(tail),
              `id が元データの way 番号になっていない: ${c.id}（${c.sourceRoad}）`);
  }

  // 並びを変えても同じ id になること
  const again = buildCandidates("石川県", "ishikawa", [...ishikawa.elements].reverse());
  const byName = (rows) => Object.fromEntries(rows.map((c) => [`${c.sourceRoad}/${c.lengthMeters}`, c.id]));
  assert.deepStrictEqual(byName(again), byName(list), "元データの並びが変わるとidも変わる");
});

test("同じ名前で離れた2本は、別の規制として扱う", () => {
  // ⚠️ 石川の材料では同じ名前の鎖が1本しか残らず、ここが確かめられない。
  //    同じ道路名が離れた場所に2本あるのは普通で（バイパスと旧道など）、
  //    名前だけで断片を集めると **種別が混ざり、id も同じになる**。
  //    id が同じだと、片方を登録したときにもう片方も登録済みに見える
  const line = (lat, lng, tags, id) => ({
    type: "way", id, tags: { name: "テスト線", highway: "tertiary", ...tags },
    geometry: [...Array(6)].map((_, i) => ({ lat: lat + i * 0.0012, lon: lng })),
  });
  const elements = [
    line(35.00, 139.00, { motorcycle: "no" }, 101),
    line(36.00, 140.00, { "motorcycle:conditional": "no @ (21:00-05:00)" }, 202),
  ];

  const list = buildCandidates("千葉県", "chiba", elements);
  assert.strictEqual(list.length, 2, `2本に分かれていない（${list.length}本）`);
  assert.notStrictEqual(list[0].id, list[1].id, "離れた2本に同じidを付けている");

  const allDay = list.find((c) => c.activeHours === null);
  const night = list.find((c) => c.activeHours !== null);
  assert.ok(allDay && night, "終日と夜間が混ざってしまっている: "
            + JSON.stringify(list.map((c) => c.activeHours)));
  assert.deepStrictEqual(night.activeHours, { from: "21:00", to: "05:00" });
});

test("意味の同じタグの揺れでは注意書きを出さない", () => {
  // ⚠️ ホワイトロードは55片のうち39片に `moped=no` が付き、18片に付いていない。
  //    どちらも読み替えれば同じ「終日の二輪通行禁止」。生タグで比べると
  //    「区間によって規制の書かれ方が違う」が全部の道に出て、
  //    **本当に違う道が埋もれる**（実際にそうなっていた）
  const list = buildCandidates("石川県", "ishikawa", ishikawa.elements);
  const white = list.find((c) => c.sourceRoad === "白山白川郷ホワイトロード");
  assert.ok(white, "候補が出ていない");
  // ⚠️ `reason === null` で見ないこと。この道を登録すると「登録済みと重なる」が
  //    入るので、**関係の無い理由でこのテストが落ちる**（実際に落ちた）。
  //    見たいのは「区間によって違う」の注意書きが出ていないことだけ
  assert.ok(!(white.reason || "").includes("区間によって"),
            "同じ意味のタグの揺れで注意書きが出ている: " + white.reason);
});

// MARK: 原付だけ通れない道（バイパス・一般有料道路）

/**
 * ⚠️ ここを読まないと、原付が乗れない道を原付の人におすすめし続ける。
 *    実際に神奈川県のおすすめに、湯河原パークウェイ80.1点・芦ノ湖スカイライン76.5点・
 *    ターンパイク箱根50.4点が載っていた。
 *    この形の道は `motorcycle=designated`（二輪はむしろ通れる）になっていて、
 *    `motorcycle=no` では1本も引っ掛からない。
 */
test("原付だけ通れない道を規制として拾う", () => {
  const f = toCandidateFields({ name: "湯河原パークウェイ", moped: "no", motorcycle: "designated" });
  assert.strictEqual(f.blocks, true, "原付通行禁止を見逃している");
  assert.strictEqual(f.sourceTag, "moped=no");
});

test("原付だけの規制には上限を付ける", () => {
  // ⚠️ **上限が抜けると「二輪すべて」になる。** 原付だけ禁止の道が
  //    251ccの人のおすすめからも消える
  const f = toCandidateFields({ name: "小田原厚木道路", moped: "no", motorcycle: "designated" });
  assert.strictEqual(f.maxCc, 50, "上限が付いていない（全員の規制になっている）");
  assert.strictEqual(f.minCc, null);
  assert.strictEqual(f.targetLabel, "50cc以下");
});

test("二輪も原付も禁止なら上限は付けない", () => {
  // ⚠️ 上限を付けると、251ccの人が通れない道を通れることにしてしまう
  const f = toCandidateFields({ name: "両方禁止", motorcycle: "no", moped: "no" });
  assert.strictEqual(f.maxCc, null, "全員の規制なのに原付だけの扱いにしている");
  assert.strictEqual(f.targetLabel, "二輪すべて");
});

test("原付だけの規制を通行止めにしない", () => {
  // ⚠️ 上限50ccを付けているのに「通行止め」と言うと、伝わる意味が食い違う。
  //    ⚠️ `motor_vehicle=no` が併記された場合は話が別（誰も通れないので通行止め）。
  //       そちらは「原付禁止と全車通行止めが重なったら通行止めを採る」で押さえている
  const f = toCandidateFields({ name: "湯河原パークウェイ", moped: "no", motorcycle: "designated" });
  assert.strictEqual(f.kind, "noMotorcycle", "原付だけの規制を通行止めにしている");
  assert.strictEqual(f.maxCc, 50);
});

test("原付が通れる指定は規制にしない", () => {
  assert.strictEqual(toCandidateFields({ name: "ふつうの道", moped: "yes" }).blocks, false);
});

// MARK: 自動車専用道路（125cc以下が通れない）

/**
 * ⚠️ **一律50cc以下にしないこと。** 自動車専用道路は道交法で125cc以下が通行禁止
 *    （原付二種も入れない）。実機で「125cc以下の道路が多かった」と報告された。
 *    50のままだと、原付二種の人に通れない道（小田原厚木道路など）を勧めることになる。
 */
test("自動車専用道路は125cc以下にする", () => {
  const f = toCandidateFields({ name: "小田原厚木道路", moped: "no",
                                motorcycle: "designated", motorroad: "yes" });
  assert.strictEqual(f.maxCc, 125, "自動車専用道路を50cc以下にしている");
  assert.strictEqual(f.targetLabel, "125cc以下");
});

test("ふつうの道の原付規制は50cc以下のまま", () => {
  // ⚠️ 逆に全部125にすると、原付二種で走れる道が原付二種の人から消える
  const f = toCandidateFields({ name: "湯河原パークウェイ", moped: "no" });
  assert.strictEqual(f.maxCc, 50, "ふつうの道を125cc以下にしている");
});

test("自動車専用ではないと書いてあれば50cc以下", () => {
  const f = toCandidateFields({ name: "大阪港咲洲トンネル", moped: "no", motorroad: "no" });
  assert.strictEqual(f.maxCc, 50);
});

test("排気量を当てにしないよう注意書きを付ける", () => {
  // ⚠️ **黙って決めないこと。** OSM は `moped=no` としか書かず、125cc以下なのか
  //    50cc以下なのかを区別できない。人が現地を確かめるための手掛かりを残す
  for (const tags of [{ moped: "no" }, { moped: "no", motorroad: "yes" }]) {
    const f = toCandidateFields({ name: "どこか", ...tags });
    assert.ok(f.reason && f.reason.includes("確かめること"),
              "注意書きが無い: " + JSON.stringify(tags) + " → " + f.reason);
  }
});

test("二輪すべての規制には排気量の注意書きを付けない", () => {
  // ⚠️ 全部に出すと、本当に確かめてほしいものが埋もれる
  const f = toCandidateFields({ name: "弥彦山スカイライン", motorcycle: "no" });
  assert.strictEqual(f.reason, null, "関係の無い注意書きが出ている: " + f.reason);
});

// MARK: 自動車が全部通れない道（二輪だけのタグが無い）

/**
 * ⚠️ **これを落とすと県ごとまるごと空になる。** 二輪だけのタグ（`motorcycle` / `moped`）が
 *    付いていない道でも、`motor_vehicle=no` なら二輪も通れない。
 *    実際、埼玉県は該当13本すべてがこの形で、候補0件になっていた
 *    （秩父上名栗線・畑トンネル・林道清流線など）。19県が同じ理由で空だった。
 *    クエリでは取れているのに読み替えで捨てていたので、エラーも出ず「規制なし」に見えた。
 */
test("自動車が全部通れない道も規制として拾う", () => {
  const f = toCandidateFields({ name: "秩父上名栗線", motor_vehicle: "no" });
  assert.strictEqual(f.blocks, true, "二輪も通れないのに規制にしていない");
  assert.strictEqual(f.kind, "closed", "通行止めになっていない");
  assert.strictEqual(f.maxCc, null, "排気量で切っている（誰も通れない道)");
  assert.strictEqual(f.targetLabel, "二輪すべて");
});

test("原付禁止と全車通行止めが重なったら通行止めを採る", () => {
  // ⚠️ 原付の枝で拾うと上限50ccが付き、**251ccの人が通れることになってしまう**
  const f = toCandidateFields({ name: "両方", moped: "no", motor_vehicle: "no" });
  assert.strictEqual(f.kind, "closed", "原付だけの規制にしている");
  assert.strictEqual(f.maxCc, null, `上限が付いている（${f.maxCc}）`);
});

test("自動車が通れる指定は規制にしない", () => {
  // ⚠️ 危険物だけの条件（大阪港咲洲トンネル）を通行止めにしない
  for (const tags of [{ motor_vehicle: "yes" }, { motor_vehicle: "private" },
                      { motor_vehicle: "yes", "motor_vehicle:conditional": "no @ (hazmat)" }]) {
    assert.strictEqual(toCandidateFields({ name: "どこか", ...tags }).blocks, false,
                       "規制ではないものを拾っている: " + JSON.stringify(tags));
  }
});
