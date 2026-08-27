"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { simulate, STEP_ADVANCE_METERS, SAME_TEXT_QUIET_SECONDS } =
  require("../lib/navSimulate");
const { STANDARD, imminentThreshold } = require("../lib/navGuide");

/**
 * 生成したルートの上を走らせて、出る案内を確かめるところ。
 *
 * ⚠️ **材料は実際に生成したルート。** `fixtures-nav-routes.json` に
 *    `routeWithValhalla` が返した `steps` をそのまま置いてある
 *    （5区間・指示128件。短いステップ43件・5km超のステップ15件・交差点名41件）。
 */
const FIX = path.join(__dirname, "fixtures-nav-routes.json");
const routes = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, "utf8")) : null;
const skipIfNoFixture = (t) => (routes ? false : t.skip("材料が無い環境"));
const each = () => Object.entries(routes || {});

// MARK: 案内そのもの

test("空の案内・0メートルの案内を出さない", (t) => {
  if (skipIfNoFixture(t)) return;
  for (const [key, route] of each()) {
    for (const e of simulate(route)) {
      assert.ok(e.text && e.text.trim(), `${key}: 空の案内がある`);
      // ⚠️ 桁の途中に当てないこと。「250メートル先」の中の 0 を拾ってしまう
      assert.ok(!/(^|[^0-9])0メートル先/.test(e.text), `${key}: 「${e.text}」`);
      assert.ok(!/undefined|null|NaN/.test(e.text), `${key}: 「${e.text}」`);
      assert.ok(Number.isFinite(e.atMeters) && e.atMeters >= 0,
        `${key}: 位置がおかしい ${e.atMeters}`);
    }
  }
});

test("読み上げに表示用の名前を使わない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **一度これをやった。** `roadName` は表示用で番号もローマ字も
  //    全部つないである（「舞鶴通り／Maiduru-dori／31」）。読ませると耳障り
  for (const [key, route] of each()) {
    for (const e of simulate(route)) {
      assert.ok(!e.text.includes("／"), `${key}: つなげた名前を読んでいる「${e.text}」`);
      assert.ok(!/[A-Za-z]{4,}/.test(e.text), `${key}: ローマ字を読んでいる「${e.text}」`);
    }
  }
});

test("同じ案内を、短い間に繰り返さない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **アプリの `NavVoiceGuide` と同じ抑止**（同じ文言は10秒以内なら捨てる）。
  //    これが無いと、曲がった直後の1回とそのすぐ後の遠め・近めが同じ文言になる
  //    （実測: 東京→箱根で**2m差**で
  //     「700メートル先、二重橋前交差点を内堀通りへ左折です」が2回出た）
  for (const [key, route] of each()) {
    const events = simulate(route);
    for (let i = 1; i < events.length; i++) {
      if (events[i].text !== events[i - 1].text) continue;
      assert.ok(events[i].atSeconds - events[i - 1].atSeconds >= SAME_TEXT_QUIET_SECONDS,
        `${key}: 「${events[i].text}」が `
        + `${events[i].atSeconds - events[i - 1].atSeconds}秒しか空けずに2回出ている`);
    }
  }
});

test("材料に、抑止が働く形が入っている", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ 上のテストが空振りしないこと。抑止を外したときに重複が出る材料であること
  let wouldDuplicate = 0;
  for (const [, route] of each()) {
    const seen = simulate(route);
    // 曲がった直後の案内と、その先の遠め・近めが同じ文言になりうるステップを数える
    for (const step of route.steps) {
      if (step.distanceMeters > STANDARD.far && step.distanceMeters < STANDARD.far * 1.05) {
        wouldDuplicate++;
      }
    }
    assert.ok(seen.length > 0);
  }
  assert.ok(wouldDuplicate >= 1,
    "曲がった直後と遠めが重なる長さのステップが材料に無い。抑止を確かめられていない");
});

test("案内は前から順に並ぶ", (t) => {
  if (skipIfNoFixture(t)) return;
  for (const [key, route] of each()) {
    const events = simulate(route);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].atMeters >= events[i - 1].atMeters,
        `${key}: ${events[i - 1].atMeters}m の次が ${events[i].atMeters}m`);
      // ⚠️ **時刻も戻らないこと。** ステップごとの所要時間を足し忘れると
      //    次のステップで0秒に戻る（実際にやった）
      assert.ok(events[i].atSeconds >= events[i - 1].atSeconds,
        `${key}: ${events[i - 1].atSeconds}秒 の次が ${events[i].atSeconds}秒`);
    }
    const last = events[events.length - 1];
    if (last) {
      assert.ok(last.atSeconds <= route.durationSeconds + 60,
        `${key}: 最後の案内が ${last.atSeconds}秒（経路は ${route.durationSeconds}秒）`);
    }
  }
});

// MARK: 曲がる直前

test("曲がる手前では必ず案内が出る", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **これが崩れると曲がり損ねる。** ステップが短くても直前だけは必ず言う
  for (const [key, route] of each()) {
    const events = simulate(route);
    const spokenFor = new Set(events.filter((e) => e.kind === "imminent" || e.kind === "afterTurn")
      .map((e) => e.stepIndex));
    for (let i = 0; i < route.steps.length - 1; i++) {
      if (route.steps[i + 1].maneuver === "none") continue;
      assert.ok(spokenFor.has(i),
        `${key}: ${i}番目の指示（${route.steps[i].distanceMeters}m）の先で`
        + `${route.steps[i + 1].maneuver} をするのに、直前の案内が無い`);
    }
  }
});

test("短いステップに、短いステップがある（材料の確認）", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ 上のテストが空振りしないこと。直前（60m）より短いステップが無ければ
  //    「必ず出る」を確かめられていない
  const imminent = imminentThreshold();
  const tiny = each().flatMap(([, r]) => r.steps)
    .filter((s) => s.distanceMeters > 0 && s.distanceMeters <= imminent).length;
  assert.ok(tiny >= 3,
    `直前(${imminent}m)以下のステップが ${tiny} 件しかない。材料が弱い`);
});

// MARK: 遠め・近めを言わない条件

test("短いステップで「700メートル先」と言わない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **ステップが250mしかないのに「700メートル先」は嘘になる**（アプリと同じ）
  for (const [key, route] of each()) {
    for (const e of simulate(route)) {
      if (e.kind !== "far" && e.kind !== "near") continue;
      const stepLength = route.steps[e.stepIndex].distanceMeters;
      const said = Number((e.text.match(/^(\d+)メートル先/) || [])[1]);
      if (!said) continue;
      assert.ok(stepLength >= said,
        `${key}: ${stepLength}m のステップで「${e.text}」`);
    }
  }
});

test("曲がった直後に、同じ内容を繰り返さない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ 曲がった直後の1回で「350メートル先、〜」と言ったのに、
  //    その直後に遠め（700m）でも同じことを言ってはいけない
  for (const [key, route] of each()) {
    const events = simulate(route);
    const byStep = new Map();
    for (const e of events) {
      if (!byStep.has(e.stepIndex)) byStep.set(e.stepIndex, []);
      byStep.get(e.stepIndex).push(e);
    }
    for (const [stepIndex, list] of byStep) {
      const afterTurn = list.find((e) => e.kind === "afterTurn");
      if (!afterTurn) continue;
      const stepLength = route.steps[stepIndex].distanceMeters;
      for (const e of list) {
        if (e.kind !== "far" && e.kind !== "near") continue;
        const said = Number((e.text.match(/^(\d+)メートル先/) || [])[1])
          || Number((e.text.match(/^([\d.]+)キロ先/) || [])[1]) * 1000;
        assert.ok(said < stepLength,
          `${key}: ${stepLength}m のステップで、曲がった直後に言ったのに「${e.text}」`);
      }
    }
  }
});

// MARK: その次の操作

test("「まもなく」の直後に、その次の操作も言う", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **走行中は画面を見られない。** 曲がってすぐまた曲がるとき、
  //    声で言わないと聞き逃す（アプリのコメント）
  let withFollowUp = 0;
  for (const [, route] of each()) {
    for (const e of simulate(route)) {
      if (e.kind !== "imminent") continue;
      if (/その後/.test(e.text)) withFollowUp++;
    }
  }
  assert.ok(withFollowUp > 10,
    `「その後〜」が ${withFollowUp} 件しかない（付いていないのでは）`);
});

test("最後の曲がり角には「その後」を付けない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ その先が無いのに「その後〜」と言わない
  for (const [key, route] of each()) {
    const last = route.steps.length - 2;
    for (const e of simulate(route)) {
      if (e.stepIndex !== last) continue;
      assert.ok(!/その後/.test(e.text), `${key}: 最後で「${e.text}」`);
    }
  }
});

// MARK: 長い直線を刻む

test("刻む設定が無ければ、刻まない", (t) => {
  if (skipIfNoFixture(t)) return;
  for (const [key, route] of each()) {
    const events = simulate(route);          // 既定は longStretch: 0
    assert.strictEqual(events.filter((e) => e.kind === "longStretch").length, 0,
      `${key}: 設定していないのに刻んでいる`);
  }
});

test("長い直線では、残りを刻んで伝える", (t) => {
  if (skipIfNoFixture(t)) return;
  const events = simulate(routes.highway, { announce: { longStretch: 2000 } });
  const ticks = events.filter((e) => e.kind === "longStretch");
  assert.ok(ticks.length >= 3, `刻みが ${ticks.length} 件しかない`);
  for (const e of ticks) {
    assert.ok(/をあと\d+キロです$/.test(e.text), `言い回しが違う「${e.text}」`);
  }
});

test("通常の案内と重なる手前では、刻まない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **二重に喋るとかえって煩わしい**（アプリのコメント）。
  //    いちばん遠い案内（既定700m）より手前では黙ること
  for (const [key, route] of each()) {
    const events = simulate(route, { announce: { longStretch: 1000 } });
    for (const e of events.filter((x) => x.kind === "longStretch")) {
      const stepLength = route.steps[e.stepIndex].distanceMeters;
      assert.ok(stepLength > Math.max(STANDARD.far, 1000),
        `${key}: ${stepLength}m のステップで刻んでいる`);
    }
  }
});

// MARK: 端

test("指示が足りないときは何も出さない", () => {
  assert.deepStrictEqual(simulate(null), []);
  assert.deepStrictEqual(simulate({}), []);
  assert.deepStrictEqual(simulate({ steps: [] }), []);
  assert.deepStrictEqual(simulate({ steps: [{ maneuver: "straight", distanceMeters: 100 }] }), []);
});

test("次に進む距離がアプリと揃っている", () => {
  assert.strictEqual(STEP_ADVANCE_METERS, 25);
});

test("曲がるたびに、その先を1回知らせる", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **これが無いと、曲がった先がどうなるか分からないまま走ることになる。**
  //    距離の設定を待たず、曲がった直後に必ず1回言う（アプリの
  //    `announceUpcomingAfterTurn`）。⚠️ 出発直後だけは言わない
  for (const [key, route] of each()) {
    const afterTurn = new Set(simulate(route)
      .filter((e) => e.kind === "afterTurn").map((e) => e.stepIndex));
    for (let i = 1; i < route.steps.length - 1; i++) {
      if (route.steps[i + 1].maneuver === "none") continue;
      if (!(route.steps[i].distanceMeters > 0)) continue;
      assert.ok(afterTurn.has(i),
        `${key}: ${i}番目（${route.steps[i].distanceMeters}m）で曲がった直後の案内が無い`);
    }
    assert.ok(!afterTurn.has(0), `${key}: 出発直後に「曲がった直後」の案内を出している`);
  }
});

test("刻みは、通常の案内より手前では鳴らさない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **二重に喋るとかえって煩わしい**（アプリのコメント）。
  //    残りが「いちばん遠い案内」と「刻み幅」のどちらよりも大きいときだけ鳴らす。
  //    ⚠️ ステップの長さではなく、**その時点の残り距離**で見ること。
  //    ⚠️ **遠めを刻み幅より大きくして試すこと。** 既定（遠め700m・刻み1000m）だと
  //       どちらで比べても同じ値になり、片方を外しても落ちない
  const announce = { far: 2000, near: 300, imminent: 60, longStretch: 1000 };
  const floor = Math.max(announce.far, announce.longStretch);
  let seen = 0;
  for (const [key, route] of each()) {
    const starts = [];
    let sum = 0;
    for (const step of route.steps) { starts.push(sum); sum += step.distanceMeters || 0; }

    for (const e of simulate(route, { announce })) {
      if (e.kind !== "longStretch") continue;
      seen++;
      const stepLength = route.steps[e.stepIndex].distanceMeters;
      const remaining = starts[e.stepIndex] + stepLength - e.atMeters;
      assert.ok(remaining > floor,
        `${key}: 残り ${Math.round(remaining)}m で「${e.text}」`
        + `（${floor}m より手前では黙ること）`);
    }
  }
  assert.ok(seen >= 3, `刻みが ${seen} 件しか出ていない。材料が弱い`);
});

test("ステップに入った直後には刻まない", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **曲がった直後に続けて言われると煩い**（アプリのコメント）。
  //    そのステップに入って最初に見た刻みは飛ばす
  const announce = { far: 700, near: 300, imminent: 60, longStretch: 1000 };
  for (const [key, route] of each()) {
    const starts = [];
    let sum = 0;
    for (const step of route.steps) { starts.push(sum); sum += step.distanceMeters || 0; }

    for (const e of simulate(route, { announce })) {
      if (e.kind !== "longStretch") continue;
      const into = e.atMeters - starts[e.stepIndex];
      assert.ok(into > 0,
        `${key}: ステップに入った地点（${into}m）で「${e.text}」`);
    }
  }
});

test("とても短いステップでも、直前の案内が出る", (t) => {
  if (skipIfNoFixture(t)) return;
  // ⚠️ **刻んで見ていく輪の中に一度も入らない長さがある**（25m以下）。
  //    そこで取りこぼすと、曲がる直前に何も言われない
  const tiny = [];
  for (const [key, route] of each()) {
    const events = simulate(route);
    for (let i = 0; i < route.steps.length - 1; i++) {
      const length = route.steps[i].distanceMeters;
      if (!(length > 0) || length > STEP_ADVANCE_METERS) continue;
      if (route.steps[i + 1].maneuver === "none") continue;
      tiny.push(`${key}:${i}`);
      assert.ok(events.some((e) => e.stepIndex === i),
        `${key}: ${length}m のステップで案内が1つも出ていない`);
    }
  }
  assert.ok(tiny.length >= 1,
    `${STEP_ADVANCE_METERS}m 以下のステップが材料に無い。取りこぼしを確かめられていない`);
});

test("出発してすぐ曲がるときも、案内が出る", () => {
  // ⚠️ **これだけは手で作った材料。** 実測の5区間には
  //    「出発から25m以内で最初の曲がり角」という形が無く、
  //    刻んで見ていく輪に一度も入らない場合を再現できないため。
  //    ⚠️ この形では「曲がった直後の1回」も出ない（出発直後は言わないので）。
  //    取りこぼしを拾う手当てが無いと、**最初の曲がり角が無案内になる。**
  const route = {
    lengthMeters: 1020, durationSeconds: 120,
    steps: [
      { maneuver: "straight", distanceMeters: 20, durationSeconds: 3,
        spokenRoad: "駅前通り" },
      { maneuver: "turnLeft", distanceMeters: 1000, durationSeconds: 117,
        spokenRoad: "中央通り" },
      { maneuver: "none", distanceMeters: 0, durationSeconds: 0 },
    ],
  };
  const events = simulate(route);
  const first = events.filter((e) => e.stepIndex === 0);
  assert.ok(first.length > 0, "出発してすぐの曲がり角で案内が1つも出ていない");
  assert.ok(first.some((e) => e.kind === "imminent"),
    `直前の案内が無い: ${JSON.stringify(first)}`);
  assert.ok(first[0].text.includes("左折"), `「${first[0].text}」`);
});
