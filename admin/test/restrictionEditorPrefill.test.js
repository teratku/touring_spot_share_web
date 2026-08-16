"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 規制の編集画面と一覧に、どの値を出すか。
 *
 * 【確かめること その1】まだ登録していないなら、候補が持ってきた内容を初期値にする
 * OSM から拾った規制は曜日と時間帯を持っている（旧東海道は月〜金の07:30〜09:00）。
 * ⚠️ 初期値に出ないと、**画面では終日に見えたまま登録され、通れる時間まで
 *    「通行禁止」として配信される**。エラーにはならないので気付けない。
 *
 * 【確かめること その2】登録済みなら、候補の値に戻さない
 * ⚠️ 実機で「排気量を更新しても変更できない」と報告された。
 *    `saved.maxCc ?? c.maxCc` と繋いでいたため、空欄にして登録し直しても
 *    **候補（OSM）の値に戻っていた**。登録済みの null は「まだ決めていない」ではなく
 *    **制限なしと決めた結果**。エラーは出ず入力欄が元に戻るだけなので、
 *    「保存できていない」のか「入力が効いていない」のか区別が付かない。
 *
 * 画面側の関数をHTMLから取り出して動かす（`parseLatLng.test.js` と同じやり方）。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const match = html.match(/function rEditorDefaults\(candidate, saved, isSaved\) \{[\s\S]*?\n\}/);

test("画面側に rEditorDefaults がある", () => {
  assert.ok(match, "road-builder.html から rEditorDefaults を取り出せない");
});

const rEditorDefaults = new Function(`${match[0]}; return rEditorDefaults;`)();

/** 編集欄の初期値。`saved` が空なら「まだ登録していない」扱い */
const prefill = (saved, candidate) =>
  rEditorDefaults(candidate, saved, Object.keys(saved || {}).length > 0);

/** 旧東海道（滋賀）。OSM の "no @ (Mo-Fr 07:30-09:00; Sa,Su,PH off)" 由来 */
const osmCandidate = {
  id: "osm-shiga-1", kind: "noMotorcycle",
  activeDays: [1, 2, 3, 4, 5], includesHoliday: false,
  activeHours: { from: "07:30", to: "09:00" },
};

/** 湯河原パークウェイ（神奈川）。OSM の moped=no 由来なので50cc以下 */
const mopedCandidate = {
  id: "osm-kanagawa-1", kind: "noMotorcycle", minCc: null, maxCc: 50,
  activeDays: null, activeHours: null, includesHoliday: false,
};

// MARK: まだ登録していないとき（候補を初期値にする）

test("まだ登録していない候補では、拾ってきた曜日と時間が初期値になる", () => {
  const got = prefill({}, osmCandidate);
  assert.deepStrictEqual(got.days, [1, 2, 3, 4, 5], "曜日が出ていない");
  assert.deepStrictEqual(got.hours, { from: "07:30", to: "09:00" }, "時間が出ていない");
  assert.strictEqual(got.kind, "noMotorcycle");
});

test("まだ登録していない候補では、拾ってきた排気量が初期値になる", () => {
  // ⚠️ 出ないと、原付だけの規制が「二輪すべて」として登録され、
  //    251ccの人のおすすめからも道が消える
  const got = prefill({}, mopedCandidate);
  assert.strictEqual(got.maxCc, 50, "候補の排気量が出ていない");
  assert.strictEqual(got.minCc, "", "下限に何か入っている");
});

test("時間を持たない候補では空のまま", () => {
  // 二普協の候補や、終日の規制（ホワイトロード）はここに来る
  const got = prefill({}, { id: "x" });
  assert.deepStrictEqual(got.days, [], "曜日に何か入っている");
  assert.deepStrictEqual(got.hours, {}, "時間に何か入っている");
  assert.strictEqual(got.holiday, false);
  assert.strictEqual(got.kind, "noMotorcycle", "既定が二輪通行禁止になっていない");
});

test("何も無くても既定値を返す", () => {
  // 手で足した規制は候補側が空。落ちないこと
  const got = rEditorDefaults(undefined, undefined, false);
  assert.strictEqual(got.kind, "noMotorcycle");
  assert.strictEqual(got.minCc, "");
  assert.deepStrictEqual(got.days, []);
});

// MARK: 登録済みのとき（候補に戻さない）

test("登録済みの内容が候補より優先される", () => {
  // ⚠️ 人が地図を見て直した内容を、候補の値で上書きしてはいけない
  const saved = { kind: "closed", activeDays: [6, 7], includesHoliday: true,
                  activeHours: { from: "10:00", to: "16:00" }, activeMonths: [7, 8],
                  minCc: 126, maxCc: 250 };
  const got = prefill(saved, osmCandidate);
  assert.deepStrictEqual(got.days, [6, 7], "候補の曜日で上書きしている");
  assert.deepStrictEqual(got.hours, { from: "10:00", to: "16:00" }, "候補の時間で上書きしている");
  assert.strictEqual(got.holiday, true, "祝日の指定が消えている");
  assert.strictEqual(got.kind, "closed", "種別が候補で上書きされている");
  assert.deepStrictEqual(got.months, [7, 8]);
  assert.strictEqual(got.minCc, 126);
  assert.strictEqual(got.maxCc, 250);
});

test("登録済みで空にした排気量は空のまま", () => {
  // ⚠️ **これが報告された不具合そのもの。** 50cc以下を外して「制限なし」にしたのに、
  //    候補の 50 に戻っていた
  const saved = { kind: "noMotorcycle", minCc: null, maxCc: null,
                  activeDays: null, activeHours: null, includesHoliday: false };
  const got = prefill(saved, mopedCandidate);
  assert.strictEqual(got.maxCc, "", `候補の排気量に戻っている（${got.maxCc}）`);
  assert.strictEqual(got.minCc, "", `候補の排気量に戻っている（${got.minCc}）`);
});

test("登録済みで空にした曜日・時間帯も空のまま", () => {
  // ⚠️ 排気量と同じ理由。「毎日・終日」に直したのに候補の平日07:30〜09:00に戻る
  const saved = { kind: "noMotorcycle", minCc: null, maxCc: null,
                  activeDays: null, activeHours: null, includesHoliday: false };
  const got = prefill(saved, osmCandidate);
  assert.deepStrictEqual(got.days, [], "候補の曜日に戻っている: " + JSON.stringify(got.days));
  assert.deepStrictEqual(got.hours, {}, "候補の時間帯に戻っている: " + JSON.stringify(got.hours));
});

test("登録済みで祝日を外した指定を、候補の値で戻さない", () => {
  // ⚠️ `??` ではなく `||` で書くと、false（祝日を外した）が「未指定」と扱われ、
  //    候補の値に戻ってしまう。空配列も同じ理由で `||` では扱えない
  const got = prefill({ includesHoliday: false, activeDays: [] },
                      { ...osmCandidate, includesHoliday: true });
  assert.strictEqual(got.holiday, false, "外した祝日が候補の値で戻っている");
  assert.deepStrictEqual(got.days, [], "空にした曜日が候補の値で戻っている");
});

// MARK: 一覧の「誰が対象か」

/** `rTargetLabel` を取り出す。`R.saved` は呼び出しごとに差し替える */
function targetLabel(savedMap = new Map()) {
  const src = html.match(/function rTargetLabel\(c\) \{[\s\S]*?\n\}/);
  assert.ok(src, "rTargetLabel を取り出せない");
  return new Function("R", `${src[0]}; return rTargetLabel;`)({ saved: savedMap });
}

test("まだ登録していない候補では元データの読み取り結果を出す", () => {
  assert.strictEqual(targetLabel()({ id: "a", targetLabel: "50cc以下" }), "50cc以下");
  assert.strictEqual(targetLabel()({ id: "b" }), "", "元データが無いのに何か出ている");
});

test("一覧の対象は、登録した排気量から作り直す", () => {
  // ⚠️ **これが報告された不具合そのもの。** 上限を50から125に直したのに、
  //    一覧が候補（OSM）の「50cc以下」のままだった
  const saved = new Map([["a", { minCc: null, maxCc: 125 }]]);
  assert.strictEqual(targetLabel(saved)({ id: "a", targetLabel: "50cc以下" }), "125cc以下",
                     "候補の文言のままになっている");
});

test("排気量の言い回しはアプリと揃える", () => {
  // ⚠️ ここだけ違うと、ツールで見た文言とアプリに出る文言が食い違う
  //    （`RoadRestriction.targetLabel`）
  const cases = [
    [{ minCc: null, maxCc: null }, "二輪すべて"],
    [{ minCc: 0, maxCc: 99999 }, "二輪すべて"],
    [{ minCc: null, maxCc: 50 }, "50cc以下"],
    [{ minCc: 51, maxCc: null }, "51cc以上"],
    [{ minCc: 126, maxCc: 250 }, "126〜250cc"],
  ];
  for (const [saved, want] of cases) {
    const got = targetLabel(new Map([["a", saved]]))({ id: "a", targetLabel: "候補の文言" });
    assert.strictEqual(got, want, `${JSON.stringify(saved)} が「${got}」になっている`);
  }
});

// MARK: 一覧の「いつ効くか」

/** `rScheduleLabel` を取り出す。`R.saved` は呼び出しごとに差し替える */
function scheduleLabel(savedMap = new Map()) {
  const src = html.match(/function rScheduleLabel\(c\) \{[\s\S]*?\n\}/);
  assert.ok(src, "rScheduleLabel を取り出せない");
  return new Function("R", `${src[0]}; return rScheduleLabel;`)({ saved: savedMap });
}

test("一覧に「いつ効くか」が出る", () => {
  // ⚠️ 一覧で終日と時間限定を見分けられないと、夜間だけの規制を
  //    終日のつもりで登録してしまう
  const label = scheduleLabel();
  assert.strictEqual(label(osmCandidate), "月・火・水・木・金 07:30〜09:00");
  assert.strictEqual(label({ id: "b", activeDays: [7], includesHoliday: true,
                             activeHours: { from: "00:00", to: "06:00" } }),
                     "日 祝 00:00〜06:00");
  // 日をまたぐ夜間（南田中町旭町線）
  assert.strictEqual(label({ id: "c", activeHours: { from: "21:00", to: "05:00" } }),
                     "21:00〜05:00");
  // 終日は空。何も書かないことで「時間の縛りが無い」と分かる
  assert.strictEqual(label({ id: "d" }), "", "終日なのに何か出ている");
});

test("一覧も、登録済みなら候補の時間に戻さない", () => {
  // ⚠️ 戻ると、一覧には平日07:30〜09:00、編集欄には終日、と**違う内容が同時に見える**
  const saved = new Map([[osmCandidate.id,
    { activeDays: null, activeHours: null, includesHoliday: false }]]);
  assert.strictEqual(scheduleLabel(saved)(osmCandidate), "",
                     "終日に直したのに一覧が候補の時間のまま");
});

test("一覧は登録した時間を出す", () => {
  const saved = new Map([[osmCandidate.id,
    { activeDays: [6, 7], activeHours: { from: "10:00", to: "16:00" }, includesHoliday: false }]]);
  assert.strictEqual(scheduleLabel(saved)(osmCandidate), "土・日 10:00〜16:00");
});
