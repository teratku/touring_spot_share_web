"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { normalizePeriod, periodContains, monthsOfPeriod, describePeriod, isActiveAt, describe } =
  require("../lib/restrictionTime");
const { parseSeasonalClosure, complement } = require("../lib/osmSeasonTags");
const { evaluate } = require("../lib/roadPassability");
const { buildCandidates } = require("../fetchOsmSeasonalClosures");

/**
 * 冬季閉鎖の日付（activePeriod）。
 *
 * ⚠️ 利用者の要望（2026-10-24）:「スカイラインとかの走れなくなる日付を表示」→「OSM から自動で拾い、調整ツールで直す」。
 *    閉鎖は月の途中で切られる（11/15〜4/24 など）ので、月だけでは日付を出せない。
 */

test("期間を整える（片方だけ・ありえない日は捨てる）", () => {
  assert.deepStrictEqual(normalizePeriod({ from: "11/15", to: "4-24" }), { from: "11-15", to: "04-24" });
  assert.deepStrictEqual(normalizePeriod({ from: "02-29", to: "03-01" }), { from: "02-29", to: "03-01" });
  for (const bad of [{ from: "11-15" }, { to: "04-24" }, { from: "13-01", to: "04-24" },
                     { from: "04-31", to: "05-01" }, { from: "十一月", to: "四月" }, null]) {
    assert.strictEqual(normalizePeriod(bad), null, JSON.stringify(bad) + " を通した");
  }
});

test("年をまたぐ期間の中と外", () => {
  const p = { from: "11-15", to: "04-24" };
  assert.ok(periodContains(p, 1115), "始まりの日を含めていない");
  assert.ok(periodContains(p, 101));
  assert.ok(periodContains(p, 424), "終わりの日を含めていない");
  assert.ok(!periodContains(p, 425));
  assert.ok(!periodContains(p, 1114));
  assert.ok(!periodContains(p, 801));
});

test("古いアプリ向けの月は期間がかかる月すべて", () => {
  // ⚠️ 11/15 からでも11月を入れる（月だけ見るアプリで走れると言わないように）
  assert.deepStrictEqual(monthsOfPeriod({ from: "11-15", to: "04-24" }), [11, 12, 1, 2, 3, 4]);
  assert.deepStrictEqual(monthsOfPeriod({ from: "07-01", to: "10-31" }), [7, 8, 9, 10]);
  assert.strictEqual(monthsOfPeriod({ from: "07-01", to: "10-31" }).length < 12, true);
});

test("期間の外では効かない・説明に日付が出る", () => {
  const r = { kind: "winterClosure", activePeriod: { from: "11-15", to: "04-24" } };
  assert.ok(isActiveAt(r, new Date(2026, 11, 1)));
  assert.ok(!isActiveAt(r, new Date(2026, 7, 1)), "夏も閉鎖にしている");
  assert.ok(!isActiveAt(r, new Date(2026, 3, 25)), "開通日に閉鎖にしている");
  assert.strictEqual(describePeriod(r.activePeriod), "11/15〜4/24");
  assert.strictEqual(describe(r), "11/15〜4/24");
});

test("走れるかの理由に日付を出す（アプリの RoadPassability と同じ文言）", () => {
  const line = [[138.0, 36.0], [138.0, 36.02]];
  const r = { id: "w", kind: "winterClosure", points: line, activeMonths: [11, 12, 1, 2, 3, 4],
              activePeriod: { from: "11-15", to: "04-24" } };
  const result = evaluate([line], [r], "large");
  assert.strictEqual(result.verdict, "conditional", "冬季閉鎖をいつでも走れないにしている");
  assert.deepStrictEqual(result.reasons, ["11/15〜4/24 冬季閉鎖"]);
});

// MARK: OSM のタグを読む

test("OSM の書き方から期間を読む", () => {
  const read = (tags) => (parseSeasonalClosure(tags) || {}).period;
  assert.deepStrictEqual(read({ "access:conditional": "no @ (Dec-Apr)" }), { from: "12-01", to: "04-30" });
  assert.deepStrictEqual(read({ "access:conditional": "no @ (Nov 15-Apr 25)" }), { from: "11-15", to: "04-25" });
  // 乗鞍岳線: 開いている期間だけ書かれている → その外が閉鎖
  assert.deepStrictEqual(read({ "access:conditional": "yes @ (Jul 1-Sep 30 06:00-18:00; Oct 1-Oct 31 07:00-18:00)" }),
                         { from: "11-01", to: "06-30" });
  // 白山白川郷ホワイトロード: 終日の期間だけを拾い、夜間の規制は捨てる
  assert.deepStrictEqual(read({ "access:conditional": "no @ (Nov-Jun; Jun-Aug 00:00-07:00,19:00-24:00; Sep-Nov 00:00-08:00,18:00-24:00)" }),
                         { from: "11-01", to: "06-30" });
  assert.deepStrictEqual(read({ note: "冬期 (12/1 - 3/31) 通行止め。" }), { from: "12-01", to: "03-31" });
});

test("閉鎖でないものは拾わない", () => {
  for (const tags of [
    { "access:conditional": "permit @ Jul-Oct" },                       // 許可が要る（南アルプス公園線）
    { "vehicle:conditional": "no @ (Aug 16 18:00-23:00)" },             // 祭りの1日
    { "access:conditional": "no @ (Apr-Sep: Su, PH 12:00-18:00; Oct-Mar: Su, PH 12:00-17:00)" },  // 歩行者天国
    { "access:conditional": "no @ (Nov-Jun 00:00-07:00)" },             // 夜間だけ
    { "motorcycle:conditional": "no @ (Jan 01-Jun 30 Sa,Su,PH; Jul 01-Aug 31; Sep 01-Dec 31 Sa,Su,PH)" },  // 曜日の二輪規制（枚方大和郡山線）
    { description: "冬期も開放" },
    { description: "冬季は9時から17時まで、夏季は8時30分から18時30分までの営業" },
  ]) {
    assert.strictEqual(parseSeasonalClosure(tags), null, JSON.stringify(tags) + " を閉鎖として拾った");
  }
});

test("期間の書かれていない冬季通行止めは期間なしの候補にする", () => {
  const r = parseSeasonalClosure({ description: "冬季通行止め" });
  assert.ok(r, "拾っていない");
  assert.strictEqual(r.period, null, "書かれていない期間を作っている");
  const night = parseSeasonalClosure({ description: "冬期夜間通行止め" });
  assert.ok(night && /夜間/.test(night.reason), "夜間だけの閉鎖だと添えていない");
});

test("閉まる期間が2つに割れるときは人に任せる", () => {
  // 4〜5月と9〜10月だけ開く → 閉まる期間が2つ
  assert.strictEqual(complement([{ from: 401, to: 531 }, { from: 901, to: 1031 }]), null);
  assert.deepStrictEqual(complement([{ from: 425, to: 1031 }]), { from: 1101, to: 424 });
});

test("候補は冬季閉鎖として並び、配信の形（activeMonths つき）で持つ", () => {
  const way = (id, lat) => ({
    type: "way", id, tags: { highway: "secondary", name: "テスト峠線", "access:conditional": "no @ (Dec-Apr)" },
    geometry: [{ lat, lon: 138.0 }, { lat: lat + 0.005, lon: 138.0 }],
  });
  const list = buildCandidates("長野県", "nagano-test", [way(2, 36.0), way(1, 36.005)]);
  assert.strictEqual(list.length, 1, "つながった way を1本にしていない");
  const c = list[0];
  assert.strictEqual(c.id, "osmw-nagano-test-1", "取り込み直しで変わらない id にしていない");
  assert.strictEqual(c.kind, "winterClosure");
  assert.deepStrictEqual(c.activePeriod, { from: "12-01", to: "04-30" });
  assert.deepStrictEqual(c.activeMonths, [12, 1, 2, 3, 4]);
  assert.ok(/確かめる/.test(c.reason), "確かめるよう書いていない");
});

// MARK: 保存・配信・画面

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");

test("保存で期間を残し、月を期間から作り直す", () => {
  const m = server.match(/app\.put\("\/api\/restrictions\/:romaji"[\s\S]*?\n\}\);/);
  assert.ok(m, "保存APIを取り出せない");
  assert.ok(m[0].includes("activePeriod: normalizePeriod(r.activePeriod)"), "期間を保存していない（捨てている）");
  assert.ok(m[0].includes("monthsOfPeriod(r.activePeriod)"), "月を期間から作り直していない（古いアプリと食い違う）");
});

test("冬季閉鎖の候補を規制タブに並べる", () => {
  const m = server.match(/app\.get\("\/api\/restrictions\/candidates\/:romaji"[\s\S]*?\n\}\);/);
  assert.ok(m && m[0].includes('readCandidateFile("restriction-osm-season"'), "冬季閉鎖の候補を読んでいない");
  assert.ok(m[0].includes("season.candidates"), "冬季閉鎖の候補を返していない");
});

test("編集欄で期間を入れられ、登録内容に入る", () => {
  assert.ok(html.includes('id="r-pfrom"') && html.includes('id="r-pto"'), "期間の入力欄が無い");
  const apply = html.match(/function rApplyEdit\(\) \{[\s\S]*?\n\}/);
  assert.ok(apply && apply[0].includes("activePeriod: period"), "登録内容に期間を入れていない");
  // ⚠️ 登録済みの期間を候補の値に戻さない（rEditorDefaults の決まり）
  assert.ok(html.includes("period: base.activePeriod ?? null"), "期間の初期値が登録済み／候補の決まりに沿っていない");
});

test("配信前の確かめで読めない期間を止める", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "importRestrictions.js"), "utf8");
  assert.ok(src.includes("r.activePeriod && !normalizePeriod(r.activePeriod)"), "期間の書き方を確かめていない");
});
