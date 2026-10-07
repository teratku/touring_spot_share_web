"use strict";

/**
 * 利用者の好みと行き先（開発者だけが見る画面 /riders の中身）。
 *
 * ⚠️ 利用者の要望（2026-10-07）:「投稿したスポット/スポットの札などもユーザーへおすすめスポット/道路を
 *    提供できるように解析したい」。判断: **解析はアプリ側でその人の分だけ**（`RiderSignals.swift`）。
 *    「全員の確認は web の開発者オンリーの view で確認し、マッピングや視覚的にユーザーがどんな場所に
 *    よく行くか確認できるようにしたい。今後の開発などに活かせるものにしたい」→ この画面
 * ⚠️ **好みの決め方はアプリと同じにする**（重み・特徴の作り方）。アプリを変えたらここも変える
 *    （`RiderSignals.swift` の `sourceWeight`・`RiderChoices.roadFeatures/spotFeatures`）
 * ⚠️ **誰かは出さない。** uid・名前・メールは返さず、活動の多い順の番号（利用者 #1…）で出す
 */

const { toKey } = require("./roadTags");

/** 材料ごとの重み（アプリの `RiderSignals.sourceWeight` と同じ。選んだ記録は回数をそのまま使う） */
const SOURCE_WEIGHT = { post: 1.0, plan: 1.0, review: 0.8, like: 0.6 };
/** 同じ重みのときにどの材料を理由にするか（前ほど優先） */
const SOURCE_ORDER = ["choice", "post", "plan", "review", "like"];
/** 口コミは ★4 以上だけ好みに使う（低い評価は好みではない） */
const REVIEW_MIN = 4;
/** 地図の集計の升目（度）。0.1度 ≒ 緯度で11km */
const GRID_DEG = 0.1;

const curvinessBand = (c) => (c >= 600 ? "curvy:high" : c >= 300 ? "curvy:mid" : "curvy:low");

/** 道の特徴（アプリの `RiderChoices.roadFeatures` と同じ） */
function roadFeatures(tags, highway, curviness) {
  const out = new Set((tags || []).map((t) => "tag:" + toKey(t)));
  if (highway) out.add("hw:" + highway);
  out.add(curvinessBand(curviness || 0));
  return [...out].sort();
}

/** スポットの特徴（アプリの `RiderChoices.spotFeatures` と同じ） */
function spotFeatures(points, tags) {
  return [...new Set([...(points || []).map((p) => "pt:" + p), ...(tags || []).filter((t) => t).map((t) => "genre:" + t)])].sort();
}

/**
 * 材料（{kind, key, features, weight, source}）から好みを作る。
 * ⚠️ 同じもの（kind と key が同じ）は重みのいちばん大きい材料だけを使う（投稿してプランにも入れた
 *    スポットを2回数えない）
 * @returns {{spots: object, roads: object, spotSources: object, roadSources: object}}
 *   特徴 → 重み（0...1）と、特徴 → いちばん効いた材料
 */
function tasteFromEvidence(evidence) {
  const best = new Map();
  for (const e of evidence) {
    if (!e || !e.key || !(e.weight > 0)) continue;
    const id = e.kind + "\u0000" + e.key;
    const prev = best.get(id);
    const better = !prev || e.weight > prev.weight ||
      (e.weight === prev.weight && SOURCE_ORDER.indexOf(e.source) < SOURCE_ORDER.indexOf(prev.source));
    if (better) best.set(id, e);
  }
  const make = (kind) => {
    const items = [...best.values()].filter((e) => e.kind === kind);
    const total = items.reduce((s, e) => s + e.weight, 0);
    const weights = {}, bySource = {};
    for (const e of items) {
      for (const f of new Set(e.features || [])) {
        weights[f] = (weights[f] || 0) + e.weight;
        bySource[f] = bySource[f] || {};
        bySource[f][e.source] = (bySource[f][e.source] || 0) + e.weight;
      }
    }
    const sources = {};
    for (const f of Object.keys(weights)) {
      weights[f] = total > 0 ? weights[f] / total : 0;
      sources[f] = Object.entries(bySource[f])
        .sort((a, b) => b[1] - a[1] || SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]))[0][0];
    }
    return { weights, sources };
  };
  const spots = make("spot"), roads = make("road");
  return { spots: spots.weights, roads: roads.weights, spotSources: spots.sources, roadSources: roads.sources };
}

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 全員の材料から、画面に出すものを作る。
 * @param {object} data
 *   posts:   [{id, userID, lat, lng, tag, points, road:{name,ref,highway}}]（投稿）
 *   likes:   [{userID, spotID}]（スポット配下のいいね）
 *   reviews: [{userID, spotID, rating}]（口コミ）
 *   plans:   [{userID, spots:[{spotId, lat, lng, isRoad, roadID}]}]（プラン）
 *   tastes:  [{userID, roads:{..}, spots:{..}}]（選んだ記録 user_taste）
 * @param {(lng:number, lat:number) => string|null} locate 県を引く
 */
function buildInsights(data, locate = () => null) {
  const posts = data.posts || [];
  const postById = new Map(posts.map((p) => [p.id, p]));
  const people = new Map();
  const person = (uid) => {
    if (!people.has(uid)) {
      people.set(uid, { evidence: [], points: [], counts: { post: 0, like: 0, review: 0, plan: 0, choice: 0 } });
    }
    return people.get(uid);
  };
  const addPoint = (p, lat, lng, source) => {
    const la = num(lat), ln = num(lng);
    if (la == null || ln == null) return;
    p.points.push({ lat: la, lng: ln, source });
  };
  const spotEvidence = (post, source, weight) => ({
    kind: "spot", key: post.id, source, weight,
    features: spotFeatures(post.points, post.tag),
  });

  for (const post of posts) {
    if (!post.userID) continue;
    const p = person(post.userID);
    p.counts.post++;
    p.evidence.push(spotEvidence(post, "post", SOURCE_WEIGHT.post));
    // 投稿の「近くの道」は道の好みにも使う。⚠️ ここでは道の種類だけ（アプリは配信データから道を引き当てて
    //    札・曲がり具合まで使う。全員分を引き当てると重いので、この画面では省いている）
    if (post.road && post.road.name) {
      const highway = post.road.highway || "";
      p.evidence.push({ kind: "road", key: `post:${post.id}`, source: "post", weight: SOURCE_WEIGHT.post,
                        features: highway ? ["hw:" + highway] : [] });
    }
    addPoint(p, post.lat, post.lng, "post");
  }
  for (const like of data.likes || []) {
    const post = postById.get(like.spotID);
    if (!like.userID || !post) continue;
    const p = person(like.userID);
    p.counts.like++;
    p.evidence.push(spotEvidence(post, "like", SOURCE_WEIGHT.like));
    addPoint(p, post.lat, post.lng, "like");
  }
  for (const review of data.reviews || []) {
    const post = postById.get(review.spotID);
    if (!review.userID || !post) continue;
    const p = person(review.userID);
    p.counts.review++;
    if ((review.rating || 0) >= REVIEW_MIN) p.evidence.push(spotEvidence(post, "review", SOURCE_WEIGHT.review));
    addPoint(p, post.lat, post.lng, "review");
  }
  for (const plan of data.plans || []) {
    if (!plan.userID) continue;
    const p = person(plan.userID);
    p.counts.plan++;
    for (const s of plan.spots || []) {
      const post = s.spotId ? postById.get(s.spotId) : null;
      if (post && !s.isRoad) p.evidence.push(spotEvidence(post, "plan", SOURCE_WEIGHT.plan));
      addPoint(p, s.lat, s.lng, "plan");
    }
  }
  for (const taste of data.tastes || []) {
    if (!taste.userID) continue;
    const p = person(taste.userID);
    for (const [group, kind] of [["roads", "road"], ["spots", "spot"]]) {
      for (const item of Object.values(taste[group] || {})) {
        if (!item || !item.key) continue;
        p.counts.choice++;
        p.evidence.push({ kind, key: item.key, source: "choice", weight: Math.max(1, item.count || 1),
                          features: item.features || [] });
        const post = kind === "spot" ? postById.get(item.key) : null;
        if (post) addPoint(p, post.lat, post.lng, "choice");
      }
    }
  }

  const activity = (p) => Object.values(p.counts).reduce((s, n) => s + n, 0);
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  // ⚠️ 番号は活動の多い順（同じなら uid 順で固定。uid そのものは返さない）
  const ordered = [...people.entries()].sort((a, b) => activity(b[1]) - activity(a[1]) || (a[0] < b[0] ? -1 : 1));
  const users = ordered.map(([, p], i) => {
    const taste = tasteFromEvidence(p.evidence);
    const prefs = {};
    for (const pt of p.points) {
      const pref = locate(pt.lng, pt.lat);
      if (pref) prefs[pref] = (prefs[pref] || 0) + 1;
    }
    return {
      no: i + 1,
      counts: p.counts,
      areas: top(prefs, 3),
      spotTaste: top(taste.spots, 5).map(([f, w]) => [f, Math.round(w * 100) / 100, taste.spotSources[f]]),
      roadTaste: top(taste.roads, 5).map(([f, w]) => [f, Math.round(w * 100) / 100, taste.roadSources[f]]),
      points: p.points,
    };
  });

  // 全員の合計
  const tags = {}, spotPoints = {}, highways = {};
  let withTag = 0, withPoints = 0, withRoad = 0;
  for (const post of posts) {
    const t = (post.tag || []).filter((x) => x);
    if (t.length) withTag++;
    for (const x of t) tags[x] = (tags[x] || 0) + 1;
    if ((post.points || []).length) withPoints++;
    for (const x of post.points || []) spotPoints[x] = (spotPoints[x] || 0) + 1;
    if (post.road && post.road.name) {
      withRoad++;
      const h = post.road.highway || "(不明)";
      highways[h] = (highways[h] || 0) + 1;
    }
  }
  // 地図の升目: 材料ごとの件数と、何人の行き先か
  const cells = new Map();
  for (const [uid, p] of people) {
    for (const pt of p.points) {
      const gy = Math.floor(pt.lat / GRID_DEG), gx = Math.floor(pt.lng / GRID_DEG);
      const id = gy + ":" + gx;
      if (!cells.has(id)) {
        cells.set(id, { lat: (gy + 0.5) * GRID_DEG, lng: (gx + 0.5) * GRID_DEG, total: 0, bySource: {}, people: new Set() });
      }
      const c = cells.get(id);
      c.total++;
      c.bySource[pt.source] = (c.bySource[pt.source] || 0) + 1;
      c.people.add(uid);
    }
  }
  const grid = [...cells.values()]
    .map((c) => ({ lat: Math.round(c.lat * 1000) / 1000, lng: Math.round(c.lng * 1000) / 1000,
                   total: c.total, bySource: c.bySource, people: c.people.size }))
    .sort((a, b) => b.total - a.total);
  const prefectures = {};
  for (const u of users) for (const [pref, n] of u.areas) prefectures[pref] = (prefectures[pref] || 0) + n;

  return {
    totals: {
      people: users.length,
      posts: posts.length, withTag, withPoints, withRoad,
      likes: users.reduce((s, u) => s + u.counts.like, 0),
      reviews: users.reduce((s, u) => s + u.counts.review, 0),
      plans: users.reduce((s, u) => s + u.counts.plan, 0),
      choices: users.reduce((s, u) => s + u.counts.choice, 0),
    },
    tags: top(tags, 50), spotPoints: top(spotPoints, 50), highways: top(highways, 10),
    prefectures: top(prefectures, 47),
    grid, gridDeg: GRID_DEG,
    users,
  };
}

/**
 * 本番から材料を読む（**読むだけ**）。⚠️ 必要な項目だけ（select）。メール・名前は読まない
 * - いいねは**スポットの配下**のものだけ（imagedownload/{spot}/yaehCount）。外に置いた古い控え（yaehCount）は
 *   取り消しても残るので使わない
 * - プランは users/{uid}/touringPlans
 */
async function loadRiderData(db) {
  const [postsSnap, likesSnap, womSnap, plansSnap, tasteSnap] = await Promise.all([
    db.collection("imagedownload").select("userID", "lat", "lng", "tag", "points", "road").get(),
    db.collectionGroup("yaehCount").select("userID").get(),
    db.collection("wordOfMouth").select("postUserID", "locationDocID", "womAssessment").get(),
    db.collectionGroup("touringPlans").select("spots").get(),
    db.collection("user_taste").select("roads", "spots").get(),
  ]);
  const posts = postsSnap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, userID: x.userID, lat: x.lat, lng: x.lng, tag: x.tag || [], points: x.points || [], road: x.road || null };
  });
  const likes = [];
  for (const d of likesSnap.docs) {
    const spot = d.ref.parent.parent;
    if (!spot || !spot.parent || spot.parent.id !== "imagedownload") continue;
    likes.push({ userID: d.data().userID, spotID: spot.id });
  }
  const reviews = womSnap.docs.map((d) => {
    const x = d.data();
    return { userID: x.postUserID, spotID: x.locationDocID, rating: x.womAssessment || 0 };
  });
  const plans = [];
  for (const d of plansSnap.docs) {
    const owner = d.ref.parent.parent;
    if (!owner) continue;
    const spots = (d.data().spots || []).map((s) => ({ spotId: s.spotId || null, lat: s.lat, lng: s.lng,
                                                       isRoad: s.isRoad === true, roadID: s.roadId || null }));
    plans.push({ userID: owner.id, spots });
  }
  const tastes = tasteSnap.docs.map((d) => ({ userID: d.id, ...(d.data() || {}) }));
  return { posts, likes, reviews, plans, tastes };
}

module.exports = { SOURCE_WEIGHT, REVIEW_MIN, GRID_DEG, roadFeatures, spotFeatures, tasteFromEvidence, buildInsights, loadRiderData };
