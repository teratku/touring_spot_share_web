/**
 * navSimulate.js
 *
 * 生成したルートの上を**走らせて**、そのとき出る案内を並べる。
 *
 * 【なぜ要るか】
 * アプリに載せ替えてから「案内が変」と分かるのでは遅い。
 * アプリを触らずに、Valhalla のルートで案内が使い物になるかを確かめる。
 *
 * ⚠️ **発火の規則はアプリの `NavigationEngine` から移してある。**
 *    向こうには実機で詰めた理由がコメントで書いてあるので、
 *    値や条件を変えるときは必ず向こうも読むこと。
 *
 * ⚠️ **GPS は模さない。** 経路に沿った「進んだ距離」だけで進める。
 *    位置合わせ（`NavGeometry.project`）やオフルート判定はアプリの仕事で、
 *    ここで確かめたいのは**案内の中身と出る順番**だから。
 */
"use strict";

const {
  normalized, activeDistances, imminentThreshold,
  phrase, followUpPhrase, longStretchPhrase,
} = require("./navGuide");

/**
 * 次のステップへ移ったとみなす残距離。
 * ⚠️ アプリの `NavigationEngine.stepAdvanceMeters` と同じ25m。
 */
const STEP_ADVANCE_METERS = 25;

/**
 * 同じ文言を捨てる間隔（秒）。
 * ⚠️ **アプリの `NavVoiceGuide` と同じ10秒。** 向こうは発話する直前で捨てている。
 *    こちらでも同じことをしないと、アプリでは鳴らない案内まで並べてしまう。
 * ⚠️ **実際に必要になった。** 曲がった直後の1回と、そのすぐ後の遠め・近めが
 *    同じ文言になることがある（実測: 東京→箱根で **2m差**で
 *    「700メートル先、二重橋前交差点を内堀通りへ左折です」が2回）。
 *    ステップ長が閾値をわずかに上回るときに起きる。アプリも同じ形になるが、
 *    向こうは発話側で捨てているので実機では1回しか鳴らない。
 */
const SAME_TEXT_QUIET_SECONDS = 10;

/**
 * 何メートルごとに見るか。
 * ⚠️ **細かすぎると遅く、粗すぎると閾値をまたぎ越す。** 直前の案内が
 *    いちばん小さい（既定60m）ので、その1/4より細かくしておく。
 */
const DEFAULT_TICK_METERS = 10;

/**
 * 走らせて、出る案内を並べる。
 *
 * @param {object} route `routeWithValhalla` が返す形。`steps` と `points` を使う
 * @param {object} opts  { announce, tickMeters }
 * @returns {Array<{atMeters:number, stepIndex:number, kind:string, text:string}>}
 *   kind: `afterTurn` / `far` / `near` / `imminent` / `longStretch` / `waypoint`
 */
function simulate(route, opts = {}) {
  const steps = (route && route.steps) || [];
  if (steps.length < 2) return [];

  const announce = normalized(opts.announce);
  const distances = activeDistances(announce);
  const imminent = imminentThreshold(announce);
  const tick = opts.tickMeters || DEFAULT_TICK_METERS;

  const out = [];
  let traveled = 0;                       // 出発地からの累計（m）
  let elapsed = 0;                        // 同上（秒）
  let lastText = null;
  let lastTextAt = -Infinity;

  /** アプリの `NavVoiceGuide` と同じ抑止をかけてから積む */
  const push = (event) => {
    if (event.text === lastText
        && event.atSeconds - lastTextAt < SAME_TEXT_QUIET_SECONDS) return;
    lastText = event.text;
    lastTextAt = event.atSeconds;
    out.push(event);
  };

  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    const after = steps[i + 2] || null;
    const stepLength = Math.max(0, step.distanceMeters || 0);
    const stepSeconds = Math.max(0, step.durationSeconds || 0);
    /** そのステップを走る速さ（m/s）。時間が取れないときは 40km/h とみなす */
    const speed = stepSeconds > 0 && stepLength > 0 ? stepLength / stepSeconds : 11.1;
    /** ステップの中で「残り remaining」の地点に着くまでの秒数 */
    const secondsInto = (remaining) => Math.max(0, stepLength - remaining) / speed;

    /** その閾値はもう鳴らしたか */
    const fired = new Set();
    let lastBucket = null;

    const say = (kind, meters, isImminent) => {
      push({
        atMeters: Math.round(traveled + Math.max(0, stepLength - meters)),
        atSeconds: Math.round(elapsed + secondsInto(meters)),
        stepIndex: i,
        kind,
        text: phrase({
          meters, isImminent,
          maneuver: next.maneuver,
          intersection: next.intersectionName || null,
          // ⚠️ **`roadName` を使わないこと。** あちらは表示用で、番号もローマ字も
          //    全部つないである（「舞鶴通り／Maiduru-dori／31」）。
          //    そのまま読ませると耳障りになる（実際に一度やってしまった）
          roadName: next.spokenRoad || null,
          isCurvyAhead: !!next.isCurvyAhead,
          // ⚠️ **「まもなく」の直後だけ、その次の操作も言う**（アプリと同じ）
          followUp: isImminent && after
            ? followUpPhrase(next.distanceMeters || 0, after.maneuver)
            : null,
        }),
      });
    };

    // ⚠️ **曲がった直後は、距離に関係なく1回言う。** 曲がるたびに見通しを伝える
    //    （アプリの `announceUpcomingAfterTurn`）。出発直後は言わない
    if (i > 0 && next.maneuver !== "none" && stepLength > 0) {
      const isImminent = imminent != null && stepLength <= imminent;
      say("afterTurn", stepLength, isImminent);
      // ⚠️ **直後に同じ内容を繰り返さない。** この距離以上の閾値は鳴らし済みにする。
      //    ⚠️ **いまの作りでは、この行を消しても出てくる案内は変わらない。**
      //       遠め・近めは下の「ステップが短ければ言わない」で同じものが止まり、
      //       直前は同じ文言になるので10秒の抑止で消える。
      //       それでも残してあるのは、アプリの `announceUpcomingAfterTurn` と
      //       同じ形にしておくため。**この行を守るテストは書けていない。**
      for (const meters of distances) if (meters >= stepLength) fired.add(meters);
    }

    // 残りを削りながら進む
    for (let remaining = stepLength; remaining > STEP_ADVANCE_METERS; remaining -= tick) {
      fireTriggers(remaining);
      fireLongStretch(remaining);
    }

    // ⚠️ **短いステップで直前の案内を飛ばさない。** 曲がってすぐまた曲がるとき、
    //    刻みの合間にステップを跨いでしまう。まだ鳴っていなければここで鳴らす
    //    （アプリも同じ手当てをしている）
    if (imminent != null && !fired.has(imminent) && next.maneuver !== "none") {
      fired.add(imminent);
      say("imminent", imminent, true);
    }

    traveled += stepLength;
    elapsed += stepSeconds;

    function fireTriggers(remaining) {
      for (const meters of distances) {
        if (fired.has(meters)) continue;
        if (remaining > meters) continue;
        // ⚠️ **ステップ自体が短いのに「700メートル先」とは言わない。**
        //    ただし**いちばん手前（直前）だけは必ず言う**
        if (meters !== imminent && stepLength < meters) { fired.add(meters); continue; }
        if (next.maneuver === "none") { fired.add(meters); continue; }
        fired.add(meters);
        say(meters === imminent ? "imminent" : (meters === announce.far ? "far" : "near"),
            meters, meters === imminent);
      }
    }

    /**
     * 長い直線で「〇〇をあと〇キロです」。
     * ⚠️ **通常の案内と重ならないこと。** いちばん遠い案内より手前では黙る。
     *    二重に喋るとかえって煩わしい（アプリのコメント）。
     * ⚠️ **ステップに入った直後は言わない。** 曲がった直後に続けて言われると煩い
     */
    function fireLongStretch(remaining) {
      const interval = announce.longStretch;
      if (!(interval > 0)) return;
      const quietBelow = distances[0] || 0;
      if (remaining <= Math.max(quietBelow, interval)) return;
      const bucket = Math.floor(remaining / interval);
      if (bucket === lastBucket) return;
      const first = lastBucket === null;
      lastBucket = bucket;
      if (first) return;
      push({
        atMeters: Math.round(traveled + (stepLength - remaining)),
        atSeconds: Math.round(elapsed + secondsInto(remaining)),
        stepIndex: i,
        kind: "longStretch",
        // ⚠️ 同上。読み上げ用の名前を使う
        text: longStretchPhrase(step.spokenRoad || null, (bucket + 1) * interval),
      });
    }
  }

  return out;
}

module.exports = {
  simulate, STEP_ADVANCE_METERS, DEFAULT_TICK_METERS, SAME_TEXT_QUIET_SECONDS,
};
