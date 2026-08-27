/**
 * funRouteRefine.js
 *
 * 実際に引いた経路を見て、**余計に走らされる形にした道を外す**。
 *
 * 【見るもの3種類】
 *   1. 同じ道を戻る往復 …… `navGeometry.backtracks`
 *   2. ゴールの近くを通り過ぎてから回り込んで戻る形
 *                    …… `navGeometry.alongWherePassedDestination`
 *   3. 経路案内が「Uターンです」と言っている箇所 …… `maneuver` が `uturn*`
 *
 * 【なぜ maneuver の数**だけ**では駄目か】
 * ⚠️ **経由地を through にすると、Uターンを含む経路でも `uturn` の maneuver が
 *    1件も返らない。** アプリ側の実測（3区間 / uturn 0件）と同じことが Valhalla でも
 *    起きており、実機で「Uターン0回」と表示されたまま大山まで33km下りて戻る経路が出た
 *    （実測: その案は往復66.7km）。**数え落とすので、幾何も見る。**
 *
 * 【なぜ幾何**だけ**でも駄目か】
 * ⚠️ **中央分離帯のある道でUターンすると、行きと帰りが離れるので幾何が拾えない。**
 *    実測: 新座→愛川 東・南まわりの市電通り（川崎）で、経路案内は
 *    「右方向、Uターンです」と明示しているのに `backtracks` は0件だった。
 *    行きと帰りの離隔は8〜16mで、判定の上限8m以内に入る点が1,328m中2点しかなく、
 *    二重走行の割合が0.5に届かずに捨てられていた。
 *    ⚠️ **上限を25mに上げて解決してはいけない。** アプリ側の実測で、25mにすると
 *    峠のヘアピン（離隔22〜25m）を往復と誤検出する。**2つは補い合う関係にある。**
 *
 * 【なぜ選ぶ側で防げないか】
 * ⚠️ `funRouteSelect.js` の後退チェックは、出発地→目的地の**直線**の上で見ている。
 *    往復は道そのものの都合（行き止まり・中央分離帯・一方通行）で起きるので、
 *    直線の幾何では見えない。**実際に引いてみるまで分からない。**
 *
 * 【アプリ側の運用規則をそのまま移してある】
 * ⚠️ **原因は折り返しの先端（`apex`）から探す。** 往復の入口（`location`）では
 *    特定できない（実測: 区間から1,416m離れており見つからなかった。先端は0m）。
 * ⚠️ **1本ずつ抜くのではなく、原因を外して組み立て直す。** 楽しい道が1本しかない案では
 *    「外すと何も残らない」ため何もできず、往復が残り続けた（実測5,244m）。
 * ⚠️ **覚えてよいものと、覚えてはいけないものがある。**
 *      往復        … 道路網そのものの性質。行き先が変わっても変わらない → 覚えてよい
 *      ゴール回り込み … 今回の行き先との位置関係でしかない → 覚えてはいけない
 *    後者まで覚えたため、使うほど楽しい道が減った（候補14本 → 1本）。
 * ⚠️ **回数だけでなく経過時間でも打ち切る。** 回数だけだと長距離で
 *    「ぐるぐる回ったまま戻らない」ように見える。
 *
 * ⚠️ **経路を引く処理は外から渡す。** ここでネットワークを叩かない
 *    （テストで実際の Valhalla を立てずに確かめられるようにするため）。
 */
"use strict";

const { backtracks, alongWherePassedDestination, segmentNearest, project, distance } =
  require("./navGeometry");

/**
 * ゴールからこれだけ内側のUターンは、到着のための切り返しとみなす。
 *
 * ⚠️ **実測: 東京→箱根の3案とも、ゴールから0.05km・最後から2番目の指示だった。**
 *    「目的地を渡らずに着ける側に」を指定したときに出る。
 *    おすすめ道路を探す範囲（`BLAME_WITHIN_METERS` 4km）よりずっと内側にすること。
 *    ⚠️ 大きくしすぎると、本当に道のせいで起きるUターンを見逃す
 */
const ARRIVAL_UTURN_METERS = 300;

/**
 * 経路案内の指示が「Uターンです」か。
 * ⚠️ Valhalla の maneuver 12/13（`uturnRight` / `uturnLeft`）。
 *    `lib/valhallaRoute.js` の `uTurns` と同じ数え方にすること
 */
function isUTurn(step) {
  return !!step && typeof step.maneuver === "string" && step.maneuver.startsWith("uturn");
}

/**
 * 何回まで組み立て直すか。
 *
 * ⚠️ **5回では足りない。** 実測（10区間・32案・大型/幅×5/8本）:
 *      呼び出し回数 中央3回・9割5回・**最大9回**（＝組み立て直し8回）
 *    5回で打ち切っていたため、東京→箱根の東まわりに **31.5km の往復**が残っていた
 *    （行き止まりの半島＝真鶴・房総の道を1本ずつ外していくのに8回かかる）。
 *    上限を上げても堂々巡りにはならない（10回でも20回でも同じ答えに収束した）。
 *    実際の歯止めは下の経過時間の方（実測の最大は2.4秒＝20秒の1割）。
 */
const MAX_RETRIES = 12;
/** 組み立て直しに使ってよい時間（ms）。⚠️ 回数だけだと長距離で待たされ続ける */
const MAX_ELAPSED_MS = 20_000;

/**
 * 引いた経路から、余計に走らせている原因の区間を突き止める。
 *
 * @returns {{forever: Array, once: Array, retracedMeters: number,
 *            backtracks: Array, passedDestinationAlong: number|null}}
 *   - `forever` 往復の原因。**次回以降も覚えてよい**（道路網の性質）
 *   - `once`    ゴール回り込みの原因。**覚えてはいけない**（今回の行き先次第）
 */
function blame(route, segments, destination) {
  const empty = { forever: [], once: [], uTurnManeuvers: 0, arrivalUTurns: 0,
                  retracedMeters: 0,
                  backtracks: [], passedDestinationAlong: null };
  if (!route || route.error || !Array.isArray(route.points) || route.points.length < 2) {
    return empty;
  }
  const found = backtracks(route.points);
  const forever = [];
  for (const b of found) {
    // ⚠️ **先端（apex）で探すこと。** 入口では原因から遠すぎて当たらない
    const culprit = segmentNearest(b.apex, segments);
    if (culprit && !forever.some((s) => s.id === culprit.id)) forever.push(culprit);
  }

  // 経路案内そのものが「Uターンです」と言っている箇所。
  // ⚠️ **幾何と補い合う。** 上の説明（中央分離帯）を読むこと。
  //    位置は `beginIndex`（その指示が始まる点）。実測では市電通りの端点から97m
  let uTurnManeuvers = 0;
  let arrivalUTurns = 0;
  for (const step of route.steps || []) {
    if (!isUTurn(step)) continue;
    const at = route.points[Math.min(route.points.length - 1, step.beginIndex || 0)];

    // ⚠️ **ゴールの目の前のUターンは、おすすめ道路のせいではない。**
    //    「目的地を渡らずに着ける側に」を指定すると、最後に道の反対側へ
    //    渡り直すための切り返しが入る。実測: 東京→箱根の3案とも
    //    **ゴールから0.05km・最後から2番目の指示**で uturnRight が出た。
    //    ここで原因を探すと、4km以内にあるおすすめ道路が濡れ衣で外される。
    if (destination && distance(at, destination) <= ARRIVAL_UTURN_METERS) {
      arrivalUTurns++;
      continue;
    }

    uTurnManeuvers++;
    // 行き止まりの道に入らされた結果なので、**道路網の性質**。覚えてよい
    const culprit = segmentNearest(at, segments);
    if (culprit && !forever.some((s) => s.id === culprit.id)) forever.push(culprit);
  }

  const once = [];
  const passedAlong = alongWherePassedDestination(route.points, destination);
  if (passedAlong !== null) {
    // 通り過ぎた地点より**先**にある区間が原因。経路への射影位置で切り分ける
    for (const seg of segments) {
      if (!Array.isArray(seg.start) || !Array.isArray(seg.end)) continue;
      const mid = [(seg.start[1] + seg.end[1]) / 2, (seg.start[0] + seg.end[0]) / 2];
      const proj = project(mid, route.points);
      if (!proj || proj.along <= passedAlong) continue;
      if (!once.some((s) => s.id === seg.id)) once.push(seg);
    }
  }

  return {
    forever, once, uTurnManeuvers, arrivalUTurns,
    retracedMeters: Math.round(found.reduce((a, b) => a + b.alongGapMeters, 0)),
    backtracks: found.map((b) => ({
      apex: b.apex, location: b.location,
      alongGapMeters: Math.round(b.alongGapMeters),
    })),
    passedDestinationAlong: passedAlong === null ? null : Math.round(passedAlong),
  };
}

/**
 * 往復・回り込みが消えるまで、原因を外して**組み立て直す**。
 *
 * @param {Function} rebuild  (banIds:Set) => ({ segments, waypoints }|null)
 *   ⚠️ **選び直しは呼び出し側に任せる。** ここで `selectFunRoads` を直に呼ぶと、
 *      方角や幅の指定を取りこぼす（実際に一度取りこぼした）。
 * @param {Function} routeFn  (waypoints) => Promise<route>
 */
async function dropBacktrackingRoads(initial, destination, rebuild, routeFn, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const maxElapsedMs = opts.maxElapsedMs ?? MAX_ELAPSED_MS;
  const startedAt = Date.now();

  const banned = new Set(opts.bannedIds || []);
  let picked = initial;

  // ⚠️ **覚えている道は、最初に引く前に外すこと。**
  //    案は `buildSideVariants` で一度にまとめて作るので、前の案で覚えた道が
  //    そのまま入っている。ここで外さないと、引いた経路に往復が出ても
  //    「もう覚えている」として飛ばされ、`added=false` で即座に抜けてしまい、
  //    **往復が残ったまま呼び出し1回で終わる**
  //    （実測: 高崎→草津 東 34.3km・甲府→富士吉田 東 38.0km がいずれも呼出1回）。
  //    アプリ側も同じことをしている（RouteCandidatesView.swift:
  //    「次回以降の検索では最初から外す（これが無いと毎回同じ回数だけ取り直す）」）。
  if (banned.size && (picked.segments || []).some((s) => banned.has(s.id))) {
    const fresh = rebuild(banned);
    // 全部覚えている道だったら、楽しい道なしで引く（それでも一本の線にはなる）
    picked = fresh && fresh.segments.length ? fresh : { segments: [], waypoints: [] };
  }

  let route = await routeFn(picked.waypoints);
  let calls = 1;
  const dropped = [];
  const bannedForever = [];
  let info = blame(route, picked.segments, destination);

  for (let tries = 0; tries < maxRetries; tries++) {
    const culprits = [...info.forever, ...info.once];
    if (!culprits.length) break;
    // ⚠️ **時間でも打ち切る。** 1回の組み立て直しは案を丸ごと作り直す
    if (Date.now() - startedAt >= maxElapsedMs) break;

    let added = false;
    for (const c of culprits) {
      if (banned.has(c.id)) continue;
      banned.add(c.id);
      dropped.push(c);
      if (info.forever.some((s) => s.id === c.id)) bannedForever.push(c);
      added = true;
    }
    if (!added) break;          // 同じ原因が出続けている。これ以上は進まない

    const again = rebuild(banned);
    if (!again || !again.segments.length) {
      // ⚠️ **楽しい道が尽きたら、楽しい道なしで引き直すこと。**
      //    ここで直前の経路をそのまま返すと、画面には「道0本」と出るのに
      //    往復したままの線が残る（実測: 札幌→富良野が4案とも
      //    道切れで往復1〜34kmを残していた）。
      //    楽しい道が無ければ素の経路になり、少なくとも一本の線にはなる。
      const plain = { segments: [], waypoints: [] };
      const plainRoute = await routeFn(plain.waypoints);
      calls++;
      const plainInfo = blame(plainRoute, plain.segments, destination);
      return { route: plainRoute, picked: plain,
               dropped, bannedForever, calls, ...plainInfo, ranOut: true };
    }
    picked = again;
    route = await routeFn(picked.waypoints);
    calls++;
    info = blame(route, picked.segments, destination);
  }

  return { route, picked, dropped, bannedForever, calls, ...info, ranOut: false };
}

module.exports = {
  blame, dropBacktrackingRoads, isUTurn, ARRIVAL_UTURN_METERS,
  MAX_RETRIES, MAX_ELAPSED_MS,
};
