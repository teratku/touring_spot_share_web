/**
 * funRouteSelect.js
 *
 * 出発地と目的地のあいだに「楽しい道」を何本か選んで、通す順に並べる。
 *
 * 【どこから来た処理か】
 * iOS の `FunRouteBuilder.swift`（1,059行）を移したもの。**定数は向こうの実測値をそのまま使う。**
 * 勝手に変えると、アプリと管理ツールで違うルートが出て、どちらが正しいか分からなくなる。
 *
 * 【まだ移していないもの】
 * ⚠️ **区間を途中で切る処理（`minCutFraction` / `minCutSavingsMeters`）は入れていない。**
 *    向こうは「次の区間に入るなら、いまの区間を途中で切る」ことがある（実データで623m短縮）。
 *    ここは常に区間の端から端まで走る。**その分だけ経路が長めに出る。**
 * ⚠️ 「もっと寄り道」候補（`.wide`）・別ルート候補（`buildVariants`）も入れていない。
 *
 * 【流れ】
 *   1. コリドー（直線からの横ズレ）で候補を絞る
 *   2. 点数の高い順に、予算に収まるものを貪欲に採る
 *   3. 進み具合で並べ、2-opt で入れ替えて短くする
 *   4. 各区間の入口・出口を決めて経由地にする
 */
"use strict";

// MARK: 定数（FunRouteBuilder.swift の実測値。⚠️ 勝手に変えないこと）

/** ルート生成が自分で選ぶときの点数の下限。平地の県の「数合わせ」を落とす */
const MIN_AUTO_SCORE = 40;
/** これより短い区間は拾わない。経由地を置くコストに見合わない（km） */
const MIN_SEGMENT_LENGTH_KM = 1.0;
/** これより曲がっていない道は「楽しい道」として出さない（度/km）。
 *  ⚠️ 直線の幹線を「楽しい道」として提案しないための線。実測で本物の峠は600〜870 */
const MIN_CURVINESS = 300;
/** 直線距離に対する横ズレの許容（比例項） */
const CORRIDOR_RATIO = 0.30;
/** 横ズレの絶対上限（m）。これが無いと長距離ほど際限なく広がる */
const CORRIDOR_CAP_METERS = 25_000;
/** 「区間の長さの何倍より遠くへは、その区間のためだけに外れない」 */
const CORRIDOR_LENGTH_FACTOR = 3.0;
/** 上の下限（m）。短い区間が締め出されるのを防ぐ */
const CORRIDOR_MIN_WIDTH_METERS = 5_000;
/** 直線距離を道のりに直す係数。⚠️ 直線のままだと予算が大幅に甘くなる（実測1.45〜1.6） */
const CIRCUITY_FACTOR = 1.6;
/** 後退（通り抜けてから戻る）に掛ける重み */
const BACKWARD_PENALTY_WEIGHT = 1.0;
/** 何本まで選ぶか（上限） */
const MAX_SEGMENTS = 11;
/** これを超えて後退するなら「Uターンでしか通れない」とみなし、その区間を諦める（m）。
 *  ⚠️ 実データの許容できる後退は326m（少し手前から入る程度）。1,000mはそれに
 *     3倍の余裕を持たせつつ、本物の後退（1.94km規模＝通り抜けてから同じ道を戻る）は捕まえる */
const MAX_BACKWARD_EXCURSION_METERS = 1_000;
/** 予算の既定。1.0＝寄り道なし、2.0＝全開 */
const DEFAULT_BUDGET_RATIO = 2.0;
/**
 * 出発地の手前／目的地の先へ、どれだけはみ出してよいか（直線距離に対する割合）。
 *
 * ⚠️ **これが無いと一筆書きにならない。** 目的地より先の道を拾うと、
 *    行き過ぎてから戻る経路になる。実機で報告された形がこれ
 *    （新座→愛川で、9.3km先の秦野清川線まで下りて戻っていた）。
 *
 * ⚠️ **コリドー（横ズレ）の判定では防げない。** 射影を [0,1] に丸めているので、
 *    目的地より先の点は横ズレが「目的地までの距離」になる。9.3km のはみ出しは
 *    そのときの許容 11.7km に収まってしまい、素通りしていた。
 *
 * 【しきい値の根拠（6ルートで実測）】
 *   上限なし   選択22本  戻り 平均4.8km  距離 平均172km
 *   直線の10%  選択22本  戻り 平均4.4km  距離 平均171km
 *   直線の5%   選択21本  戻り 平均2.5km  距離 平均158km   ← これ
 *   直線の0%   選択21本  戻り 平均2.4km  距離 平均160km
 *   5%より厳しくしても戻りはほぼ減らず、道だけ落ちる。
 *
 * ⚠️ **1件だけ悪化する。** 高崎→草津は戻り4.9→5.8km・179→219km になる
 *    （草津の先にある万座道路が落ち、代わりに別の道が入るため）。
 *    他の5件が大きく良くなるので、この形を採る。
 */
const MAX_OVERSHOOT_RATIO = 0.05;

// MARK: 幾何

const EARTH_R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

/** 2点の距離（m）。[経度, 緯度] */
function distance(a, b) {
  const p1 = rad(a[1]), p2 = rad(b[1]);
  const dp = p2 - p1, dl = rad(b[0] - a[0]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/**
 * 点を軸（出発地→目的地の直線）に射影する。
 *
 * ⚠️ **t を [0,1] に丸めること。** そうすると出発地の手前・目的地の先にある区間は
 *    最近傍点が端点に固定され、横ズレが自動的に大きくなる。おかげで
 *    「手前・先へどれだけはみ出してよいか」を別に判定しなくて済む。
 */
function project(point, axis) {
  const [a, b] = axis;
  // 緯度経度をそのまま平面として扱うと、日本の緯度で経度が約1.23倍に伸びる。
  // 経度を cos(緯度) で縮めてから計算する
  const k = Math.cos(rad((a[1] + b[1]) / 2));
  const px = (point[0] - a[0]) * k, py = point[1] - a[1];
  const bx = (b[0] - a[0]) * k, by = b[1] - a[1];
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { along: 0, rawAlong: 0, lateralDistance: distance(point, a) };
  const t = (px * bx + py * by) / len2;
  const clamped = Math.max(0, Math.min(1, t));
  const near = [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped];
  const axisLength = distance(a, b);
  return {
    along: distance(a, near),
    // 丸めない位置。「軸のどこにあるか（0未満＝手前、1超＝先）」を調べるとき用。
    // ⚠️ 後退の判定には使わないこと（alongOnAxis のコメント参照）
    rawAlong: t * axisLength,
    lateralDistance: distance(point, near),
    //: 軸の上のいちばん近い点。「どちら側に外れているか」を測るのに使う
    near,
  };
}

/**
 * 軸の上での位置（丸めた方）。
 *
 * ⚠️ **丸めない位置（`rawAlong`）に変えてはいけない。** 一度試したが、
 *    目的地より先／出発地より手前にある区間が全部「後退」と判定され、
 *    **8ルート中6ルートで楽しい道が1本も選ばれなくなった。**
 *
 * ⚠️ ついでに分かったこと: **はみ出しとUターンに関係は無かった。**
 *    実測24本（はみ出し0〜16.4km）で、16.4kmはみ出していてもUターン0回、
 *    はみ出し0kmでもUターン1回のものがあった。Uターンは道そのものの性質
 *    （行き止まり・中央分離帯など）で起きており、選び方では防げない。
 *    **はみ出しを理由に落とす規則を足さないこと。**
 */
const alongOnAxis = (point, axis) => project(point, axis).along;

// MARK: どちら側へ回り込むか

const deg = (r) => (r * 180) / Math.PI;

/** a から b を見た方角（0=北, 90=東, 180=南, 270=西） */
function bearing(a, b) {
  const p1 = rad(a[1]), p2 = rad(b[1]);
  const dl = rad(b[0] - a[0]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

//: 指定できる方角
const SIDES = { north: 0, east: 90, south: 180, west: 270 };
const SIDE_LABELS = { north: "北", east: "東", south: "南", west: "西" };

/**
 * その区間が、直線のどちら側に外れているか（方角）。
 * 直線の上にほぼ乗っているときは null。
 */
function sideBearing(seg, origin, destination) {
  const mid = midpoint(seg);
  if (!mid) return null;
  const proj = project(mid, [origin, destination]);
  // ⚠️ ほぼ直線上の点は向きが定まらない。10m を切ったら「どちらでもない」
  if (proj.lateralDistance < 10) return null;
  return bearing(proj.near, mid);
}

/**
 * 指定した方角の側にあるか（半平面で見る）。
 *
 * ⚠️ **候補は「旅の向きと直角の2方向」に集まる。** 実測:
 *      新座→愛川（226°へ）   北西4本 / 南東1本
 *      甲府→富士吉田（132°へ） 北東5本 / 南西3本
 *      高崎→草津（313°へ）   北東10本 / 南西22本
 *    そのため「北」と「西」が同じ群を指すことがある（南西へ向かう旅なら
 *    「北まわり」と「西まわり」は同じ意味）。これは幾何の通りで、間違いではない。
 *
 * ⚠️ **旅の向きと同じ方角を選ぶと、ほぼ何も残らない。** 南へ向かう旅で
 *    「南まわり」を選んでも、直角にしか外れないので当たらない。
 *    呼び出し側は「0本だった」と分かる形で伝えること。
 */
function matchesSide(sideDegrees, segmentBearing) {
  if (segmentBearing == null) return false;
  const diff = Math.abs(((segmentBearing - sideDegrees + 540) % 360) - 180);
  return diff < 90;
}

/** "north" / "北" / 数値 のいずれでも受ける。分からなければ null */
function normalizeSide(side) {
  if (side == null || side === "") return null;
  if (Number.isFinite(side)) return ((side % 360) + 360) % 360;
  const key = String(side).toLowerCase();
  if (key in SIDES) return SIDES[key];
  for (const [k, label] of Object.entries(SIDE_LABELS)) {
    if (String(side) === label) return SIDES[k];
  }
  return null;
}

// MARK: 区間

/** 区間の中点。start / end は [緯度, 経度] で来るので入れ替える */
function midpoint(seg) {
  if (!Array.isArray(seg.start) || !Array.isArray(seg.end)) return null;
  return [(seg.start[1] + seg.end[1]) / 2, (seg.start[0] + seg.end[0]) / 2];
}
const startOf = (seg) => [seg.start[1], seg.start[0]];
const endOf = (seg) => [seg.end[1], seg.end[0]];

/**
 * 直線から極端に外れていないか。
 *
 * ⚠️ 3つの上限のうち**いちばん厳しいもの**を使う。
 *    比例項だけだと長距離で際限なく広がり、遠くの区間を寄せ集めて回り込む経路になる
 *    （実測: 東京→仙台で横190kmまで許してしまった）。
 */
function isWithinCorridor(seg, origin, destination, directDistance, corridorScale = 1) {
  if (!(seg.lengthKm >= MIN_SEGMENT_LENGTH_KM)) return false;
  if (!(seg.curviness >= MIN_CURVINESS)) return false;
  const mid = midpoint(seg);
  if (!mid) return false;
  const scale = Math.max(1, corridorScale);
  const allowed = Math.min(
    Math.min(directDistance * CORRIDOR_RATIO, CORRIDOR_CAP_METERS),
    Math.max(CORRIDOR_MIN_WIDTH_METERS, CORRIDOR_LENGTH_FACTOR * seg.lengthKm * 1000),
  ) * scale;
  const proj = project(mid, [origin, destination]);
  if (proj.lateralDistance > allowed) return false;

  // ⚠️ 横ズレとは別に、**軸の外へどれだけ出ているか**を見る（MAX_OVERSHOOT_RATIO 参照）
  const t = proj.rawAlong / directDistance;
  const overshoot = t > 1 ? (t - 1) * directDistance
                  : (t < 0 ? -t * directDistance : 0);
  return overshoot <= directDistance * MAX_OVERSHOOT_RATIO * scale;
}

/** 区間の「次の目標」。次があればその中点、無ければ目的地 */
function nextTarget(index, segments, destination) {
  const next = segments[index + 1];
  return next ? (midpoint(next) || destination) : destination;
}

/**
 * どちらの端から入るかを決める。
 *
 * ⚠️ **接近距離だけで決めないこと。** 入口が近くても、通り抜ける向きが
 *    出発地→目的地の進みに逆らっていると「行って戻る」になる。
 *    軸の上での後退量をコストに足して比べる（実データで878.7mの後退を見逃していた）。
 */
function traversal(seg, cursor, target, tripOrigin, tripDestination) {
  const start = startOf(seg), end = endOf(seg);
  const axis = [tripOrigin, tripDestination];
  const cursorAlong = alongOnAxis(cursor, axis);
  const startAlong = alongOnAxis(start, axis);
  const endAlong = alongOnAxis(end, axis);

  const viaStartBackward = Math.max(0, cursorAlong - startAlong) + Math.max(0, startAlong - endAlong);
  const viaEndBackward = Math.max(0, cursorAlong - endAlong) + Math.max(0, endAlong - startAlong);

  const viaStart = distance(cursor, start) + distance(end, target)
    + viaStartBackward * BACKWARD_PENALTY_WEIGHT;
  const viaEnd = distance(cursor, end) + distance(start, target)
    + viaEndBackward * BACKWARD_PENALTY_WEIGHT;

  const entersAtStart = viaStart <= viaEnd;
  return {
    entry: entersAtStart ? start : end,
    exit: entersAtStart ? end : start,
    // ⚠️ 途中で切る処理は移していないので、常に全長を走る
    traversedMeters: (seg.lengthKm || 0) * 1000,
  };
}

/** 並べた区間を経由地（入口・出口の並び）にする */
function waypointsFor(ordered, origin, destination) {
  const out = [];
  let cursor = origin;
  ordered.forEach((seg, i) => {
    const t = traversal(seg, cursor, nextTarget(i, ordered, destination), origin, destination);
    out.push(t.entry, t.exit);
    cursor = t.exit;
  });
  return out;
}

/** 見積もりの総距離（m）。区間の間は直線×係数で見る */
function pathLength(segments, origin, destination) {
  let total = 0;
  let cursor = origin;
  segments.forEach((seg, i) => {
    const t = traversal(seg, cursor, nextTarget(i, segments, destination), origin, destination);
    total += distance(cursor, t.entry) * CIRCUITY_FACTOR;
    total += t.traversedMeters;
    cursor = t.exit;
  });
  return total + distance(cursor, destination) * CIRCUITY_FACTOR;
}

/**
 * 出発地→目的地の進み具合で並べる。
 * ⚠️ 「出発地からの距離」で並べないこと。横に散らばった区間で前後してジグザグになる。
 */
function orderedByProgress(segments, origin, destination) {
  const axis = [origin, destination];
  return segments
    .map((seg) => ({ seg, at: alongOnAxis(midpoint(seg), axis) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.seg);
}

/** 並び順を入れ替えて短くする。中点だけの並びでは最善にならないことがある */
function twoOptImprove(segments, origin, destination) {
  if (segments.length < 3) return segments;
  let best = segments.slice();
  let bestLength = pathLength(best, origin, destination);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice();
        const piece = candidate.slice(i, j + 1).reverse();
        candidate.splice(i, piece.length, ...piece);
        const length = pathLength(candidate, origin, destination);
        // 1m未満の改善は浮動小数の揺れとして無視する
        if (length < bestLength - 1) {
          best = candidate;
          bestLength = length;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * 経由地に直したとき、軸の上でいちばん大きく後退する幅（m）。後退が無ければ0。
 *
 * ⚠️ 出発地・目的地も並びに含めること。区間どうしの間だけ見ると、
 *    最後の区間から目的地へ戻るような並びを見逃す。
 */
function worstBackwardExcursion(segments, origin, destination) {
  const wps = waypointsFor(segments, origin, destination);
  if (!wps.length) return 0;
  const axis = [origin, destination];
  const track = [origin, ...wps, destination];
  const alongs = track.map((p) => alongOnAxis(p, axis));
  let worst = 0;
  for (let i = 1; i < alongs.length; i++) worst = Math.min(worst, alongs[i] - alongs[i - 1]);
  return -worst;
}

// MARK: 本体

/**
 * 楽しい道を選んで、通す順に並べる。
 *
 * @param {[number,number]} origin       [経度, 緯度]
 * @param {[number,number]} destination  [経度, 緯度]
 * @param {Array} segments  おすすめ道路（/api/roads/segments の segments）
 * @param {object} opts
 *   - count         何本まで（既定4・上限11）
 *   - budgetRatio   予算の倍率（既定2.0）
 *   - corridorScale 探す幅の倍率（既定1）
 * @returns {{segments, waypoints, detourRatio, baselineMeters, estimatedMeters, considered}}
 */
function selectFunRoads(origin, destination, segments, opts = {}) {
  const directDistance = distance(origin, destination);
  if (!(directDistance > 0)) return null;

  const baseline = directDistance * CIRCUITY_FACTOR;
  const budget = baseline * (opts.budgetRatio ?? DEFAULT_BUDGET_RATIO);
  const limit = Math.max(1, Math.min(opts.count ?? 4, MAX_SEGMENTS));

  // ⚠️ **方角の指定は、コリドーを通ったあとに掛ける。** 先に掛けると
  //    「そもそも遠すぎる道」まで数に入って、何本落としたのか分からなくなる
  const side = normalizeSide(opts.side);
  const inCorridor = (segments || []).filter((s) =>
    s.score >= MIN_AUTO_SCORE
    && Array.isArray(s.start) && Array.isArray(s.end)
    && isWithinCorridor(s, origin, destination, directDistance, opts.corridorScale));
  const candidates = side == null ? inCorridor
    : inCorridor.filter((s) => matchesSide(side, sideBearing(s, origin, destination)));
  if (!candidates.length) {
    return { segments: [], waypoints: [], detourRatio: 1, baselineMeters: baseline,
             estimatedMeters: baseline, considered: 0, sideDropped: 0 };
  }

  // ⚠️ **点数 ÷ 遠回り距離 で選ばないこと。** 点数の幅（実測52〜84）に対して
  //    距離の差が大き過ぎ、直線のすぐ脇の**凡庸な道が「安い」だけで勝つ**。
  //    寄り道の安さではなく道の良さで選ぶ。距離は「予算に収まるか」だけに使う。
  const byScore = candidates.slice().sort((a, b) => b.score - a.score);
  const chosen = [];
  let chosenLength = baseline;

  while (chosen.length < limit) {
    let picked = null;
    for (const candidate of byScore) {
      if (chosen.some((s) => s.id === candidate.id)) continue;
      const trial = orderedByProgress(chosen.concat([candidate]), origin, destination);
      const length = pathLength(trial, origin, destination);
      if (length > budget) continue;
      picked = { segment: candidate, length };
      break;         // 点数順に見て、予算に収まった最初のものを採る
    }
    if (!picked) break;
    chosen.push(picked.segment);
    chosenLength = picked.length;
  }

  const sideDropped = side == null ? 0 : inCorridor.length - candidates.length;
  const empty = { segments: [], waypoints: [], detourRatio: 1, baselineMeters: Math.round(baseline),
                  estimatedMeters: Math.round(baseline), considered: candidates.length,
                  sideDropped, uTurnOnly: [] };
  if (!chosen.length) return empty;

  // ⚠️ **並べ替えただけでは後退が消えないことがある。**
  //    `traversal` の後退ペナルティは「その区間をどちらから入るか」しか直せず、
  //    並び順そのものの悪さは 2-opt でも取り切れない。
  //    それでも大きく後退するなら「Uターンでしか組み込めない」とみなし、
  //    **点数のいちばん低い区間から諦めて選び直す。**
  //    （元の要望:「Uターンしかないなら楽しい道を通す必要はない」）
  let remaining = chosen.slice();
  const uTurnOnly = [];
  while (remaining.length) {
    const ordered = twoOptImprove(orderedByProgress(remaining, origin, destination), origin, destination);
    const waypoints = waypointsFor(ordered, origin, destination);
    if (!waypoints.length) break;

    if (worstBackwardExcursion(ordered, origin, destination) <= MAX_BACKWARD_EXCURSION_METERS) {
      const estimated = pathLength(ordered, origin, destination);
      return {
        segments: ordered,
        waypoints,
        detourRatio: estimated / baseline,
        baselineMeters: Math.round(baseline),
        estimatedMeters: Math.round(estimated),
        considered: candidates.length,
        sideDropped,
        uTurnOnly: uTurnOnly.map((s) => s.name),
      };
    }
    const weakest = remaining.reduce((a, b) => (a.score <= b.score ? a : b));
    uTurnOnly.push(weakest);
    remaining = remaining.filter((s) => s.id !== weakest.id);
  }
  return { ...empty, uTurnOnly: uTurnOnly.map((s) => s.name) };
}

/** 2つの区間の集合がどれだけ重なっているか（0=まったく違う、1=同じ） */
function overlapRatio(a, b) {
  const A = new Set(a.map((s) => s.id));
  const B = new Set(b.map((s) => s.id));
  const union = new Set([...A, ...B]);
  if (!union.size) return 0;
  let both = 0;
  for (const id of A) if (B.has(id)) both++;
  return both / union.size;
}

//: 別ルートとして出してよい重なりの上限。これ以上重なるなら同じルート扱い
const MAX_VARIANT_OVERLAP = 0.5;
//: 「ひかえめ」の予算
const MODEST_BUDGET_RATIO = 1.35;
//: 「もっと寄り道」で、探す幅を何倍にするか
const WIDE_CORRIDOR_SCALE = 2.0;
//: 「もっと寄り道」の予算
const WIDE_BUDGET_RATIO = 2.0;

/**
 * 楽しい道の通し方を、**複数**作る。
 *
 * ⚠️ **同じ道が1本しか無い地域では、たっぷりとひかえめが同じになる。**
 *    そのときのために「もっと寄り道」（幅を広げて拾い直す）を最後に足す。
 *    実機で「所沢→相模原で3kmの1本きり」と報告されたのがこれ。
 *
 * ⚠️ **幅を広げるのは、足りないときだけ。** 恒常的に広げると、遠くの区間を
 *    寄せ集めて大きく回り込む経路になる（CORRIDOR_CAP_METERS の注意書き）。
 *
 * @returns {Array<{kind, label, ...selectFunRoads の返り値}>}
 */
function buildFunVariants(origin, destination, segments, opts = {}) {
  const count = opts.count ?? 4;
  const maxVariants = opts.maxVariants ?? 3;
  const out = [];

  // ⚠️ **方角の指定は全部の案に同じものを渡す。** 案ごとに変えると、
  //    「北まわりを選んだのに南の案が出る」ことになる
  const side = opts.side ?? null;
  const generous = selectFunRoads(origin, destination, segments,
    { count, side, budgetRatio: opts.budgetRatio ?? DEFAULT_BUDGET_RATIO });
  if (!generous || !generous.segments.length) return out;
  const generousOpts = { count, side, budgetRatio: opts.budgetRatio ?? DEFAULT_BUDGET_RATIO };
  out.push({ kind: "generous", label: "たっぷり", pickOptions: generousOpts, ...generous });
  if (maxVariants < 2) return out;

  // ひかえめ: 予算だけ絞る。
  // ⚠️ 候補を除外して選び直すより、予算を絞る方が安定して別ルートになる（実測）
  const modestBudget = Math.min(MODEST_BUDGET_RATIO, opts.budgetRatio ?? DEFAULT_BUDGET_RATIO);
  const modest = selectFunRoads(origin, destination, segments,
    { count, side, budgetRatio: modestBudget });
  if (modest && modest.segments.length
      && overlapRatio(modest.segments, generous.segments) < 1) {
    out.push({ kind: "modest", label: "ひかえめ",
               pickOptions: { count, side, budgetRatio: modestBudget }, ...modest });
  }
  if (out.length >= maxVariants) return out;

  // 別ルート: たっぷりの上位2本を外して選び直す
  const topIds = new Set(generous.segments.slice()
    .sort((a, b) => b.score - a.score).slice(0, 2).map((s) => s.id));
  const alternate = selectFunRoads(origin, destination,
    segments.filter((s) => !topIds.has(s.id)),
    { count, side, budgetRatio: opts.budgetRatio ?? DEFAULT_BUDGET_RATIO });
  if (alternate && alternate.segments.length
      && out.every((v) => overlapRatio(v.segments, alternate.segments) < MAX_VARIANT_OVERLAP)) {
    // ⚠️ 別ルートは「たっぷりの上位2本を外す」のが持ち味。選び直すときも外し続ける
    out.push({ kind: "alternate", label: "別ルート",
               pickOptions: { ...generousOpts, excludeIds: [...topIds] }, ...alternate });
  }
  if (out.length >= maxVariants) return out;

  // もっと寄り道: 幅と予算を広げて拾い直す。
  // ⚠️ ここで MAX_VARIANT_OVERLAP を使わないこと。これは元の道に**足す**候補なので、
  //    たっぷりを丸ごと含んだまま重なりが 0.5 になり、必ず弾かれる。
  //    見るべきは「他の候補に無い道が増えているか」。
  //
  // ⚠️ **下の「新しい道が増えているか」の条件は、外してもテストが落ちない。**
  //    狙いは「たっぷり＝{a,b} / 別ルート＝{c,d} に対して {a,c} を組み替えただけ」の
  //    ような、道が1本も増えていないのに『もっと寄り道』と名乗る候補を防ぐこと。
  //    実データでその形を作れておらず（所沢→相模原・松本→上田では必ず新しい道が入る）、
  //    **外して良い保証は無い。** 消すなら先に再現するテストを書くこと。
  //    （移し元の FunRouteBuilder.swift にも同じ断り書きがある）
  const wide = selectFunRoads(origin, destination, segments,
    { count, side, budgetRatio: Math.max(WIDE_BUDGET_RATIO, opts.budgetRatio ?? 0),
      corridorScale: WIDE_CORRIDOR_SCALE });
  if (wide && wide.segments.length
      && wide.segments.some((c) => !out.some((v) => v.segments.some((s) => s.id === c.id)))) {
    out.push({ kind: "wide", label: "もっと寄り道",
               pickOptions: { count, side, corridorScale: WIDE_CORRIDOR_SCALE,
                              budgetRatio: Math.max(WIDE_BUDGET_RATIO, opts.budgetRatio ?? 0) },
               ...wide });
  }
  return out;
}

module.exports = {
  buildFunVariants, overlapRatio,
  MAX_VARIANT_OVERLAP, MODEST_BUDGET_RATIO, WIDE_CORRIDOR_SCALE, WIDE_BUDGET_RATIO,
  selectFunRoads, isWithinCorridor, orderedByProgress, twoOptImprove, worstBackwardExcursion,
  bearing, sideBearing, matchesSide, normalizeSide, SIDES, SIDE_LABELS,
  pathLength, waypointsFor, traversal, midpoint, project, distance,
  MIN_AUTO_SCORE, MIN_SEGMENT_LENGTH_KM, MIN_CURVINESS, CORRIDOR_RATIO,
  CORRIDOR_CAP_METERS, CORRIDOR_LENGTH_FACTOR, CORRIDOR_MIN_WIDTH_METERS,
  CIRCUITY_FACTOR, MAX_SEGMENTS, DEFAULT_BUDGET_RATIO, MAX_BACKWARD_EXCURSION_METERS,
  MAX_OVERSHOOT_RATIO,
};
