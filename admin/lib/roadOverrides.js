/**
 * roadOverrides.js
 *
 * 自動生成した区間に、開発者の判断を上書きする層。
 *
 * 【なぜ要るのか】
 * 自動判定は曲率と長さしか見ていない。標高も景観もデータに無いので、
 * ビーナスライン（29.9km・曲率435）は118位にしかならない。
 * あの道の価値は見晴らしで、数字には表れない。
 * 逆に、曲がってはいるが走って面白くない道も上位に来る。
 * そこを手で直せるようにする。
 *
 * 【再生成しても消えないこと】
 * ⚠️ 区間の id（"栃木県:12" のような並び順）を鍵にしてはいけない。
 *    重みを変えるだけで順番が動き、別の道に調整が付いてしまう。
 *    道路名と場所で照合する。区間の切り出しが多少ずれても追随できるよう、
 *    完全一致で当たらなければ「同じ名前・近い場所」で拾い直す。
 */
"use strict";

const { distanceMeters } = require("./roadCsv");
const { decode, encode, profile } = require("./polyline");
const { build, score: scoreOf } = require("./funSegments");

/** 場所を丸める粗さ（度）。0.01度 ≒ 1.1km */
const KEY_PRECISION = 0.01;
/** 完全一致しなかったときに、同じ名前で拾い直す距離 */
const FUZZY_MATCH_METERS = 3000;

/**
 * 調整を紐づける鍵。道路名＋始点をおおまかに丸めたもの。
 * @param {{name: string, start: [number, number]}} segment start は [緯度, 経度]
 */
function overrideKey(segment) {
  const round = (v) => (Math.round(v / KEY_PRECISION) * KEY_PRECISION).toFixed(2);
  return `${segment.name}@${round(segment.start[0])},${round(segment.start[1])}`;
}

/** 調整1件の既定値 */
function normalizeOverride(raw = {}) {
  return {
    /** 一覧から外す */
    hidden: raw.hidden === true,
    /** 点数への加算（0〜100 の点数に足す）。マイナスで下げる */
    boost: Number.isFinite(raw.boost) ? Math.max(-100, Math.min(100, raw.boost)) : 0,
    /** 表示名の上書き。OSM の名前が実感と違うとき（例: 湯河原箱根線 → 椿ライン） */
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null,
    /** ひとこと説明 */
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null,
    /** 「絶景」「ワインディング」などの札 */
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string" && t.trim()) : [],
    /**
     * 手で直した形（符号化した線）。区間を切り詰めたり、先へ延ばしたりしたもの。
     *
     * ⚠️ 自動生成は「曲がっている所」を機械的に切り出すので、
     *    ・峠の入口の直線が少し足りない／余分に付いている
     *    ・面白いのは途中までなのに、市街地まで含まれている
     *    といったズレが出る。そこを人が直せるようにする。
     *
     * ⚠️ **形を変えたら距離・曲率・点数も測り直すこと。** 形だけ差し替えると、
     *    「6.0km・曲率123」と出したまま実際は3kmの線、という嘘が配信される。
     */
    shape: typeof raw.shape === "string" && raw.shape.trim() ? raw.shape.trim() : null,
    /** 誰がいつ触ったかの控え（運用の手がかり。配信には載せない） */
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/** 手で足した道の既定値 */
function normalizeAdded(raw = {}) {
  const o = normalizeOverride(raw);
  return {
    /** アプリに出る名前。**必須**（無いものは足せない） */
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    /**
     * 道路の種別。点数の計算に効く（`funSegments.score`）。
     *
     * ⚠️ 既定を `secondary` にしている。生成側の対象は
     *    primary/secondary/tertiary/trunk なので、その真ん中を取る。
     *    ここを変えると同じ形でも点数が変わるので、画面から選べるようにしてある。
     */
    highway: typeof raw.highway === "string" && raw.highway.trim() ? raw.highway.trim() : "secondary",
    /** 道の形。**必須**。これを measure し直して距離・曲率・点数を出す */
    shape: o.shape,
    boost: o.boost,
    title: o.title,
    note: o.note,
    tags: o.tags,
    updatedAt: o.updatedAt,
  };
}

/**
 * 日本の範囲。
 * ⚠️ 配信前の検証（`importRoadRecommend.js`）と**同じ値にすること**。
 *    ここが緩いと、保存はできるのに配信でその県まるごと止まる。
 */
const JAPAN_BOUNDS = { minLat: 20, maxLat: 46, minLng: 122, maxLng: 154 };

/**
 * これより短い道はおすすめにしない。
 * ⚠️ 0m の線は配信の検証で弾かれる（`lengthKm > 0`）。そこまで行く前に止める。
 */
const MIN_ADDED_METERS = 200;

/** 足せる状態か。判定は `buildAddedSegment` に任せて、二重に書かない */
function isValidAdded(raw) {
  return buildAddedSegment(raw) !== null;
}

/**
 * 手で足した道を、生成した区間と同じ形の1件に組み立てる。
 *
 * ⚠️ **距離・曲率・点数を自分で書かせないこと。** 形から測り直す（`reshape`）。
 *    手入力させると、実際の線と数字が食い違ったまま配信される。
 * ⚠️ `id` はここで付けない。生成の最後に順位で振り直される
 *    （`buildRoadRecommend.js` の `${pref}:${i}`）。
 */
function buildAddedSegment(entry) {
  const a = normalizeAdded(entry);
  if (!a.name || !a.shape) return null;
  const skeleton = {
    name: a.name, ref: "", highway: a.highway,
    osmId: null, spotCount: 0, tags: a.tags,
    title: a.title, note: a.note,
  };
  const built = reshape(skeleton, a.shape);
  if (built === skeleton) return null;          // 線が壊れている（点が足りない）
  const { reshaped, ...rest } = built;

  // ⚠️ **短すぎる線を通さないこと。** 壊れた符号列でも2点には復号できてしまう
  //    （実際に "@@@" が 0m の線として通り、アフリカ沖の道になりかけた）。
  if (!(rest.lengthKm * 1000 >= MIN_ADDED_METERS)) return null;
  // ⚠️ **日本の外を通さないこと。** ここで止めないと、配信の検証で
  //    その県まるごと止まる（`importRoadRecommend.js`）。保存した本人が
  //    原因に辿り着けないので、足すときに弾く。
  const [lat, lng] = rest.start;
  if (lat < JAPAN_BOUNDS.minLat || lat > JAPAN_BOUNDS.maxLat
      || lng < JAPAN_BOUNDS.minLng || lng > JAPAN_BOUNDS.maxLng) return null;
  const score = a.boost !== 0
    ? Number(Math.max(0, Math.min(100, rest.score + a.boost)).toFixed(1))
    : rest.score;
  return {
    ...rest,
    score,
    baseScore: rest.score,
    ...(a.boost !== 0 ? { boost: a.boost } : {}),
    // 生成データ由来ではないと分かるようにする（画面の印・運用の手がかり）
    added: true,
  };
}

/**
 * 手で直した形に合わせて、測って分かることを全部やり直す。
 *
 * ⚠️ 生成と同じ式（funSegments の build / score）を使うこと。ここで別の計算を
 *    書くと、手直しした道だけ別の物差しで並ぶ。
 */
function reshape(segment, encoded) {
  const points = decode(encoded);
  if (points.length < 2) return segment;      // 壊れた線は無視して元のまま

  const p = profile(points);
  if (p.points.length < 2) return segment;
  const metrics = build(p, 0, p.points.length - 1);
  const scored = scoreOf(metrics, segment.highway);

  return {
    ...segment,
    polyline: encoded,
    pointCount: points.length,
    // ⚠️ **並びが違う。** `decode` が返すのは [経度, 緯度]、配信データの start/end は
    //    [緯度, 経度]（例: [36.066321, 139.130317]）。ここを取り違えると、
    //    調整の鍵（道路名＠始点）が別の場所を指し、次の生成で調整が当たらなくなる。
    start: [points[0][1], points[0][0]],
    end: [points[points.length - 1][1], points[points.length - 1][0]],
    lengthKm: Number((metrics.lengthMeters / 1000).toFixed(2)),
    curviness: Number(metrics.curviness.toFixed(1)),
    flow: Number(metrics.flow.toFixed(1)),
    turnCount: metrics.turnCount,
    score: Number(scored.score.toFixed(1)),
    reshaped: true,
  };
}

/** 何も指定していない調整か（空の調整はファイルに残さない） */
function isEmptyOverride(o) {
  const n = normalizeOverride(o);
  return !n.hidden && n.boost === 0 && !n.title && !n.note && n.tags.length === 0 && !n.shape;
}

/**
 * 区間に調整を当てる。
 *
 * @param {Array} segments score 降順である必要はない（この関数の中で並べ直す）
 * @param {Object} overrides 鍵 → 調整
 * @returns {{ segments, applied, unmatched }}
 *   applied   … 実際に当たった鍵
 *   unmatched … どの区間にも当たらなかった鍵（道が消えた・名前が変わった等。UIで知らせる）
 */
function applyOverrides(segments, overrides = {}, added = {}) {
  const entries = Object.entries(overrides).map(([key, value]) => ({
    key,
    override: normalizeOverride(value),
    // 鍵から名前と座標を戻す（あいまい照合に使う）
    parsed: parseKey(key),
  }));

  const byKey = new Map(entries.map((e) => [e.key, e]));
  const used = new Set();
  const result = [];

  for (const segment of segments) {
    const key = overrideKey(segment);
    let hit = byKey.get(key);
    if (!hit) hit = fuzzyMatch(segment, entries, used);
    if (!hit) { result.push({ ...segment }); continue; }

    used.add(hit.key);
    const o = hit.override;
    if (o.hidden) continue;   // 一覧から外す

    // ⚠️ 形の直しを先に当てること。点数の加算は「直したあとの点数」に足す。
    //    逆にすると、切り詰めて点数が下がったぶんまで加算が食われる
    let next = o.shape ? reshape(segment, o.shape) : { ...segment };
    if (o.boost !== 0) {
      next.score = Number(Math.max(0, Math.min(100, next.score + o.boost)).toFixed(1));
      next.boost = o.boost;
    }
    if (o.title) next.title = o.title;
    if (o.note) next.note = o.note;
    if (o.tags.length) next.tags = o.tags;
    result.push(next);
  }

  // ⚠️ **手で足した道はここで混ぜる。** 生成データには無いので、上のループでは出てこない。
  //    混ぜてから並べ直すことで、生成した道と同じ物差しで順位が付く。
  // ⚠️ 生成データに同じ鍵の道があるなら足さない。二重に出る
  //    （名前が付いていなかった道に名前を付けて足したあと、OSM 側にも名前が入った、など）。
  const existingKeys = new Set(result.map((s) => overrideKey(s)));
  const addedKeys = [];
  const skipped = [];
  for (const [key, value] of Object.entries(added || {})) {
    if (existingKeys.has(key)) { skipped.push(key); continue; }
    const segment = buildAddedSegment(value);
    if (!segment) { skipped.push(key); continue; }
    result.push(segment);
    addedKeys.push(key);
  }

  result.sort((a, b) => b.score - a.score);
  return {
    segments: result,
    applied: [...used],
    unmatched: entries.filter((e) => !used.has(e.key)).map((e) => e.key),
    /** 実際に足した道の鍵 */
    added: addedKeys,
    /** 足さなかった鍵（生成データに同じ道がある／線が壊れている） */
    addSkipped: skipped,
  };
}

/** "国道120号@36.75,139.60" → { name, lat, lng } */
function parseKey(key) {
  const at = key.lastIndexOf("@");
  if (at < 0) return null;
  const [lat, lng] = key.slice(at + 1).split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { name: key.slice(0, at), lat, lng };
}

/**
 * 完全一致しなかったときの拾い直し。
 * 同じ道路名で、始点が FUZZY_MATCH_METERS 以内なら同じ区間とみなす。
 * 区間の切り出しが少し動いただけで調整が外れるのを防ぐ。
 */
function fuzzyMatch(segment, entries, used) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of entries) {
    if (used.has(entry.key) || !entry.parsed) continue;
    if (entry.parsed.name !== segment.name) continue;
    const d = distanceMeters(
      [entry.parsed.lng, entry.parsed.lat],
      [segment.start[1], segment.start[0]]
    );
    if (d <= FUZZY_MATCH_METERS && d < bestDistance) { bestDistance = d; best = entry; }
  }
  return best;
}

module.exports = {
  overrideKey, applyOverrides, normalizeOverride, isEmptyOverride, reshape,
  normalizeAdded, isValidAdded, buildAddedSegment,
  KEY_PRECISION, FUZZY_MATCH_METERS, JAPAN_BOUNDS, MIN_ADDED_METERS,
};
