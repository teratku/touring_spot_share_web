"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { SURFACE_CAP_KMH, adjustedSeconds, applyRealisticTime } =
  require("../lib/realisticTime");

/** 指示1つ。`kmh` から時間を逆算して作る */
function step(kmh, meters, roadKind = "surface") {
  return { distanceMeters: meters,
           durationSeconds: Math.round((meters / 1000) / kmh * 3600),
           roadKind };
}
const kmhOf = (st) => (st.distanceMeters / 1000) / (st.durationSeconds / 3600);

test("速すぎる下道は上限まで落とす", () => {
  // ⚠️ 実測の壊れ方: maxspeed 未登録の国道に 90km/h が当たっていた
  const st = step(90, 10000);
  const before = st.durationSeconds;
  const after = adjustedSeconds(st);
  assert.ok(after > before, "速すぎるのに伸びていない");
  const kmh = (10000 / 1000) / (after / 3600);
  assert.ok(Math.abs(kmh - SURFACE_CAP_KMH) < 0.5,
            `上限まで落ちていない: ${kmh.toFixed(1)}km/h`);
});

test("上限より遅い下道はそのまま", () => {
  // ⚠️ **速くしないこと。** 渋滞で遅い区間を上限まで引き上げたら改悪になる
  const st = step(30, 10000);
  assert.strictEqual(adjustedSeconds(st), st.durationSeconds);
});

test("高速と有料には上限をかけない", () => {
  // ⚠️ そこは実際に速く走れる。実測: 東京→名古屋（高速あり）は +1分しか変わらない
  for (const kind of ["expressway", "toll"]) {
    const st = step(90, 20000, kind);
    assert.strictEqual(adjustedSeconds(st), st.durationSeconds, `${kind} を触っている`);
  }
});

test("短すぎる指示は速度として読まない", () => {
  // ⚠️ 数十mの「左折します」は時間のほとんどが交差点の上乗せで、
  //    速度に直すと意味の無い値になる（触ると曲がるたびに時間が増える）
  const st = step(90, 50);
  assert.strictEqual(adjustedSeconds(st), st.durationSeconds);
});

test("時間や距離が無い指示で落ちない", () => {
  for (const st of [{}, null, undefined,
                    { distanceMeters: 0, durationSeconds: 0 },
                    { distanceMeters: 5000, durationSeconds: 0 },
                    { distanceMeters: 0, durationSeconds: 100 }]) {
    const got = adjustedSeconds(st);
    assert.ok(Number.isFinite(got), `数にならない: ${JSON.stringify(st)}`);
  }
});

test("経路ぜんぶに当てると、指示の時間そのものが書き換わる", () => {
  // ⚠️ **合計だけ直しても意味がない。** 画面は区間ごとの合計を足して出すので、
  //    指示の側を直さないと内訳と合わなくなる
  const steps = [step(90, 10000), step(30, 5000), step(80, 20000)];
  const before = steps.map((s) => s.durationSeconds);
  const res = applyRealisticTime(steps);
  assert.strictEqual(res.before, before.reduce((a, b) => a + b, 0));
  assert.strictEqual(res.after, steps.reduce((a, s) => a + s.durationSeconds, 0),
                     "返した合計と、書き換えた指示の総和が違う");
  assert.ok(res.after > res.before, "伸びていない");
  assert.strictEqual(res.touched, 2, "直した本数が合わない（遅い1本は触らない）");
  assert.strictEqual(steps[1].durationSeconds, before[1], "遅い指示を触っている");
});

test("当てた後は、どの下道も上限を超えない", () => {
  const steps = [step(90, 10000), step(74, 8000), step(60, 3000),
                 step(46, 2000), step(30, 5000)];
  applyRealisticTime(steps);
  for (const st of steps) {
    assert.ok(kmhOf(st) <= SURFACE_CAP_KMH + 0.5,
              `上限を超えたまま: ${kmhOf(st).toFixed(1)}km/h`);
  }
});

test("二度当てても変わらない", () => {
  // ⚠️ 引き直しのたびに時間が伸びていくと、リルートで到着予定が狂う
  const steps = [step(90, 10000), step(74, 8000)];
  const first = applyRealisticTime(steps).after;
  const second = applyRealisticTime(steps).after;
  assert.strictEqual(second, first, "当てるたびに伸びている");
  assert.strictEqual(applyRealisticTime(steps).touched, 0, "もう直すところは無いはず");
});

test("上限を上げると時間は短くなる", () => {
  // ⚠️ 値を変えたときの向きの確認。逆になっていたら符号を間違えている
  const mk = () => [step(90, 10000), step(74, 8000)];
  const a = applyRealisticTime(mk(), 40).after;
  const b = applyRealisticTime(mk(), 45).after;
  const c = applyRealisticTime(mk(), 50).after;
  assert.ok(a > b && b > c, `向きがおかしい: 40→${a} 45→${b} 50→${c}`);
});

test("実測した数字を再現する", () => {
  // ⚠️ **利用者のツーリングの実測。** 372.3km を 402分（平均55.5km/h）と見積もり、
  //    実際に動いていたのは617分（平均39.1km/h）だった。
  //    ここが崩れたら、補正が効かなくなったということ
  const kmTotal = 372.3;
  // 未登録の速い道が半分、ふつうの下道が半分、という作りで近似する
  const steps = [step(74, kmTotal * 1000 * 0.5), step(44, kmTotal * 1000 * 0.5)];
  const before = steps.reduce((a, s) => a + s.durationSeconds, 0);
  const res = applyRealisticTime(steps);
  const kmhBefore = kmTotal / (before / 3600);
  const kmhAfter = kmTotal / (res.after / 3600);
  assert.ok(kmhBefore > 50, `補正前が楽観的でない: ${kmhBefore.toFixed(1)}`);
  assert.ok(kmhAfter < 45.5 && kmhAfter > 39,
            `補正後が実測(39.1km/h)へ寄っていない: ${kmhAfter.toFixed(1)}`);
});
