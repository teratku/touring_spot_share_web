"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  toCandidate, motorcycleTarget, vehicleBits, parseHours, parseGeometry,
  VEHICLE_D, BLOCKING_KINDS, DAY_CODES, NO_MAX,
} = require("../lib/jarticRestrictions");

/**
 * JARTIC の交通規制情報から、二輪に効く規制を取り出すところ。
 *
 * ⚠️ **材料は実際に取り込んだ県のファイル**（`data/restriction-jartic/*.json`）。
 *    無い環境では飛ばす。手作りの材料だけで固めない。
 */
const DIR = path.join(__dirname, "..", "data", "restriction-jartic");
const built = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")))
  : [];
const skipIfNotBuilt = (t) => (built.length ? false : t.skip("取り込み済みの県が無い環境"));
const allCandidates = () => built.flatMap((b) => b.candidates);

/** 実データの1行をそのまま置いたもの（神奈川・湯本元箱根線の土日祝規制） */
const REAL_ROW = {
  "共通規制種別コード": "4",
  "ユニークキー": "14202606000002800000053700100057",
  "規制場所の経度緯度": "139.10 35.23;139.11 35.24;139.12 35.25",
  "対象車両コード1_D": "10",          // 自二輪
  "規制時間1_開始": "800",
  "規制時間1_終了": "1500",
  "規制曜日コード1": "2",             // 土曜・日曜・休日
  "県別規制種別名称": "通行禁止",
  "意思決定改正日": "2023/06/29",
};

// MARK: 対象車両のコード

test("桁の位置でビットを読む", () => {
  // ⚠️ **数値の大小ではなく桁の位置。** 仕様書の共通コード表がそう作られている
  assert.deepStrictEqual([...vehicleBits("1")], [1]);
  assert.deepStrictEqual([...vehicleBits("10")], [2]);
  assert.deepStrictEqual([...vehicleBits("1000")], [4]);
  assert.deepStrictEqual([...vehicleBits("1010")], [2, 4]);
  assert.deepStrictEqual([...vehicleBits("100000000000000")], [15]);
  assert.deepStrictEqual([...vehicleBits("")], []);
  assert.deepStrictEqual([...vehicleBits("あ")], []);
});

test("二輪の区分を排気量の範囲に落とす", () => {
  // ⚠️ 道路交通法の区分に合わせること（`restrictionTarget.js` と同じ考え方）
  assert.deepStrictEqual(motorcycleTarget({ "対象車両コード1_D": "1" }, 1),
    { minCc: 0, maxCc: NO_MAX, names: ["二輪"] });            // 二輪＝原付も含む
  assert.deepStrictEqual(motorcycleTarget({ "対象車両コード1_D": "10" }, 1),
    { minCc: 51, maxCc: NO_MAX, names: ["自二輪"] });          // 原付は含まない
  assert.deepStrictEqual(motorcycleTarget({ "対象車両コード1_D": "1000" }, 1),
    { minCc: 0, maxCc: 50, names: ["原付"] });
  assert.deepStrictEqual(motorcycleTarget({ "対象車両コード1_D": "10000" }, 1),
    { minCc: 51, maxCc: 125, names: ["小二輪"] });
});

test("二輪に関係しない規制は拾わない", () => {
  // 大型（B）・大特（C）だけの通行禁止。実測で山梨に160件あった形
  assert.strictEqual(motorcycleTarget(
    { "対象車両コード1_B": "1", "対象車両コード1_C": "100000000" }, 1), null);
  assert.strictEqual(motorcycleTarget({ "対象車両コード1_D": "100000" }, 1), null);  // 軽車両
  assert.strictEqual(motorcycleTarget({ "対象車両コード1_D": "1000000" }, 1), null); // 歩行者
});

test("「車両」全般は拾わない", () => {
  // ⚠️ **カテゴリAの「車両」は原付を含む**が、実測で神奈川だけで36,588件あり、
  //    その大半は生活道路への進入規制でツーリングの経路と関係しない。
  //    ここで混ぜると人が確認しきれない。要るなら別の窓口にすること
  assert.strictEqual(toCandidate({ ...REAL_ROW,
    "対象車両コード1_D": "", "対象車両コード1_A": "1" }), null);
});

// MARK: 通れなくなる規制だけ

test("通れなくならない規制は拾わない", () => {
  // ⚠️ **実測で山梨の二輪3件はすべて「車両通行区分帯」**。二輪が対象ではあるが
  //    通れなくなるわけではない。混ぜると「通行止め」として登録されかねない
  for (const code of ["20", "21", "55", "56"]) {   // 車両通行帯 / 通行区分 / 二段階右折 / 小回り
    assert.strictEqual(toCandidate({ ...REAL_ROW, "共通規制種別コード": code }), null,
      `規制種別 ${code} を通行止めとして拾っている`);
  }
  for (const code of BLOCKING_KINDS) {
    assert.ok(toCandidate({ ...REAL_ROW, "共通規制種別コード": code }),
      `規制種別 ${code} を拾えていない`);
  }
});

// MARK: 時間と曜日

test("終日は時間指定として持たない", () => {
  // ⚠️ 0〜2400 は「いつでも」。時間指定として持つと、24時間の帯として扱われて
  //    「いまは規制されていない」判定が起きうる
  assert.strictEqual(parseHours("0", "2400"), null);
  assert.strictEqual(parseHours("0000", "2400"), null);
  assert.strictEqual(parseHours("800", "800"), null);
  assert.strictEqual(parseHours("", ""), null);
});

test("時間をアプリの形にする", () => {
  assert.deepStrictEqual(parseHours("800", "1500"), { from: "08:00", to: "15:00" });
  assert.deepStrictEqual(parseHours("2200", "600"), { from: "22:00", to: "06:00" });
});

test("曜日コードを 1(月)〜7(日) に直す", () => {
  // ⚠️ `restrictionTime.normalizeDays` に合わせる（1=月 … 7=日）
  const c = toCandidate(REAL_ROW);
  assert.deepStrictEqual(c.activeDays, [6, 7]);      // 土曜・日曜
  assert.strictEqual(c.includesHoliday, true);        // ＋休日
  assert.strictEqual(c.jartic.dayLabel, "土曜・日曜・休日");
});

test("日付に落とせない曜日コードを、勝手に埋めない", () => {
  // ⚠️ 99（その他）は「規制内容を参照」。適当な曜日を入れてはいけない
  const c = toCandidate({ ...REAL_ROW, "規制曜日コード1": "99" });
  assert.strictEqual(c.activeDays, null);
  assert.strictEqual(c.jartic.dayLabel, DAY_CODES["99"].label);
});

// MARK: 形

test("座標を線にする", () => {
  assert.deepStrictEqual(parseGeometry("138.5 35.7;138.6 35.8"),
    [[138.5, 35.7], [138.6, 35.8]]);
  assert.deepStrictEqual(parseGeometry(""), []);
  assert.deepStrictEqual(parseGeometry("こわれた"), []);
});

test("線にならないものは候補にしない", () => {
  // ⚠️ 1点では地図で確かめられない。**黙って通すと確認できない候補が混ざる**
  assert.strictEqual(toCandidate({ ...REAL_ROW, "規制場所の経度緯度": "138.5 35.7" }), null);
  assert.strictEqual(toCandidate({ ...REAL_ROW, "規制場所の経度緯度": "" }), null);
});

// MARK: 実際に取り込んだもの

test("取り込んだ県に、出典が付いている", (t) => {
  if (skipIfNotBuilt(t)) return;
  // ⚠️ **規約が求めている。** 出典と「加工した」旨の両方が要る
  for (const b of built) {
    assert.ok(/日本道路交通情報センター/.test(b.attribution), `${b.prefecture}: 出典が無い`);
    assert.ok(/加工/.test(b.attribution), `${b.prefecture}: 加工した旨が無い`);
    assert.ok(b.targetMonth, `${b.prefecture}: 対象月が無い`);
  }
});

test("取り込んだ候補が、登録の形になっている", (t) => {
  if (skipIfNotBuilt(t)) return;
  for (const c of allCandidates()) {
    assert.strictEqual(c.kind, "noMotorcycle");
    assert.strictEqual(c.source, "jartic");
    assert.ok(c.points.length >= 2, `点が ${c.points.length} しかない`);
    assert.ok(Number.isFinite(c.minCc) && Number.isFinite(c.maxCc));
    assert.ok(c.minCc <= c.maxCc, `排気量が逆 ${c.minCc}〜${c.maxCc}`);
    // 画面が読む欄（二普協・OSM の候補と同じ形）
    for (const key of ["id", "chainPolyline", "sourceRoad", "targetLabel", "confidence", "reason"]) {
      assert.ok(c[key] != null, `${key} が無い`);
    }
    assert.strictEqual(c.confidence, "JARTIC");
  }
});

test("道路名は推定だと分かるようにする", (t) => {
  if (skipIfNotBuilt(t)) return;
  // ⚠️ **JARTIC に道路名は入っていない**（実測: 路線名0%・交差点名0%・始終点0%）。
  //    手元のグリッドから当てているので、断定してはいけない
  for (const c of allCandidates()) {
    if (!c.name) { assert.strictEqual(c.nameSource, null); continue; }
    assert.strictEqual(c.nameSource, "grid", `${c.name}: 出どころが記されていない`);
    assert.ok(Number.isFinite(c.nameDistanceMeters), `${c.name}: どれだけ離れているか不明`);
  }
});

test("曜日・時間つきの規制が実際に取れている", (t) => {
  if (skipIfNotBuilt(t)) return;
  // ⚠️ **これが JARTIC を入れた理由そのもの。** OSM の日本データに曜日は0件、
  //    二普協の一覧にも無い。ここが0になったら、入れた意味が無くなっている
  const withTime = allCandidates().filter((c) => c.activeHours).length;
  assert.ok(withTime > 0,
    "時間つきの規制が1件も取れていない（実測: 神奈川10件・大阪14件・新潟25件）");
});
