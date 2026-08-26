/**
 * valhallaRoute.js
 *
 * ローカルで動かしている Valhalla に経路を頼む。
 *
 * 【なぜ要るか】
 * 自前探索（`roadRoute.js`）が返すのは**線と道路名だけ**で、「200m先を右折」を作れない。
 * アプリの `NavStep` は maneuver / instruction / roadName を要求しており、
 * いまは Google Directions が埋めている。Valhalla はそれを自前のデータで作れる。
 *
 * 【立ち上げ方】
 *   docker run -d --name valhalla-jp -p 8002:8002 valhalla-jp-cloudrun:latest
 *
 * ⚠️ **Valhalla が居なくても管理ツールが動くこと。** 落ちていたら分かる形で
 *    エラーを返し、他の画面を巻き込まないこと。
 *
 * ⚠️ **ポリラインの精度が違う。** Valhalla は小数6桁、Google と
 *    このツールの `lib/polyline.js` は5桁。**そのまま渡すと10倍ずれた線になる。**
 *    ここで5桁に直してから返す。
 *
 * ⚠️ **経由地は type=through にする。** break にすると区間が分かれ、
 *    「そこで一度止まる」扱いになって指示が増える。
 *    楽しい道を通したいだけなら through。
 */
"use strict";

const { encode } = require("./polyline");

const BASE = process.env.VALHALLA_URL || "http://localhost:8002";
//: 案内文の既定の言語。⚠️ 地域を増やすときは呼ぶ側から渡すこと
const DEFAULT_LANGUAGE = "ja-JP";
//: 1本にかける上限。全国どこでも実測1秒未満だが、落ちているときに待ち続けないため
const TIMEOUT_MS = 30_000;

/**
 * Valhalla のポリライン（小数6桁）を解く。
 * ⚠️ `lib/polyline.js` の decode は5桁前提なので使い回せない。
 */
function decode6(text) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < text.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = text.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    points.push([lng / 1e6, lat / 1e6]);   // [lng, lat] に揃える（このツールの流儀）
  }
  return points;
}

/** 2点の距離（m）。経由地の重なりを見るためだけに使う簡易版 */
function metersBetween(a, b) {
  const R = 6_371_000, rad = (d) => (d * Math.PI) / 180;
  const p1 = rad(a[1]), p2 = rad(b[1]);
  const dp = p2 - p1, dl = rad(b[0] - a[0]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Valhalla の maneuver 番号 → アプリの NavManeuver。実測13種類すべて写せている */
const MANEUVER = {
  1: "straight", 2: "straight", 3: "straight",
  4: "none", 5: "none", 6: "none",
  7: "straight", 8: "straight",
  9: "turnSlightRight", 10: "turnRight", 11: "turnSharpRight",
  12: "uturnRight", 13: "uturnLeft",
  14: "turnSharpLeft", 15: "turnLeft", 16: "turnSlightLeft",
  17: "ramp", 18: "rampRight", 19: "rampLeft",
  20: "rampRight", 21: "rampLeft",
  22: "straight", 23: "keepRight", 24: "keepLeft",
  25: "merge", 37: "merge", 38: "merge",
  26: "roundaboutRight", 27: "roundaboutRight",
  28: "ferry", 29: "ferry",
};

/**
 * 案の作り分け。**遠回りを作るのは経由地で、ここの重みではない**（実測で確認済み）。
 *
 * ⚠️ **原付とバイクで効く設定が違う。** `use_primary` は motor_scooter 専用で、
 *    motorcycle には**まったく効かない**。それに気づかず同じ設定を渡していたため、
 *    バイクの「楽しい」が **77.8km 中 66.5km を高速道路**（関越道・圏央道・中央道）で
 *    走る経路になっていた。
 *
 * 【バイクで効いた設定（実測・新座→愛川）】
 *     既定             77.8km 高速66.5km 曲率 57度
 *     use_highways 0   51.7km 高速 0.0km 曲率128度  ← これだけ
 *
 * ⚠️ **効かない設定を足さないこと。** 次はどれも経路を1mも変えなかった:
 *    `use_primary` / `use_living_streets` / `use_tracks` / `use_trails` /
 *    `service_penalty` / `maneuver_penalty` / `use_tolls`（6区間で確認）。
 *
 * ⚠️ **`top_speed` は入れない。** 1件で曲率128→149と出たので入れかけたが、
 *    6区間で測り直したら**4件で悪化か横ばい**だった（高崎→草津 423→317、
 *    福岡→阿蘇 149→142）。しかも所要時間はどこでも増える。1件で決めないこと。
 *
 * ⚠️ つまり**バイクには道の良し悪しを選ぶつまみが無い。**「楽しい」と「ふつう」の
 *    違いは高速に乗るかどうかだけになる。楽しさは**経由地**で作る。
 *
 * ⚠️ **「ふつう」で高速を外さないこと。** アプリの `avoidHighways` の既定は false で、
 *    126cc以上は高速に乗れる。「ふつう＝いちばん速い道」を保つ。
 *    外すのは「楽しい」だけ（高速から景色は楽しめない）。
 */
/* ⚠️ **表示名（「最短」など）はここに置かない。** 呼ぶ側が鍵から作る。
      置くと、APIを外に出したときに応答へ日本語が混ざる。 */
const VARIANTS = {
  shortest: {
    motor_scooter: { use_primary: 0.9, shortest: true },
    motorcycle:    { shortest: true },
  },
  normal: {
    motor_scooter: {},
    motorcycle:    {},
  },
  fun: {
    motor_scooter: { use_primary: 0.05 },
    motorcycle:    { use_highways: 0 },
  },
};

/**
 * 排気量の区分。アプリの `BikeProfile.BikeDisplacement` と揃える。
 *
 * ⚠️ **50cc / 125cc は高速・自動車専用道を通れない（法令）。**
 *    `motor_scooter` costing は既定でも避けるが**保証ではない**ので、
 *    `use_highways: 0` を明示する。**画面の指定では緩められないこと。**
 *
 * ⚠️ **`top_speed` は入れない。** 「原付は30km/h制限だから top_speed 30」は誤り。
 *    Valhalla の `top_speed` は「その速度より速い道を避ける」であって、
 *    「その速度で走る」ではない。30 を渡すと**60km/hの一般道をほぼ全部避ける**。
 *    原付は60km/hの道を走れる（速度だけ30に抑える）ので、避けるのは間違い。
 *    ⚠️ 楽しさのつまみとしても駄目なことが実測済み（VARIANTS の注意書き参照）。
 */
const DISPLACEMENTS = {
  moped50:   { costing: "motor_scooter", canUseExpressway: false },
  small125:  { costing: "motor_scooter", canUseExpressway: false },
  medium250: { costing: "motorcycle",    canUseExpressway: true },
  large:     { costing: "motorcycle",    canUseExpressway: true },
};

/**
 * @param {[number,number]} from        [lng, lat]
 * @param {[number,number]} to          [lng, lat]
 * @param {object} opts
 *   - vias      [[lng,lat], ...]  通したい点（楽しい道の入口・出口）
 *   - variant   "shortest" | "normal" | "fun"
 *   - costing   "motor_scooter"（既定） | "motorcycle"
 *   - excludePolygons  [[[lng,lat], ...], ...]  通れない範囲（規制）
 *   - language  案内文の言語（既定 "ja-JP"）
 *   - baseUrl   Valhalla の場所（既定は環境変数 VALHALLA_URL）
 */
async function routeWithValhalla(from, to, opts = {}) {
  const variant = VARIANTS[opts.variant] || VARIANTS.normal;
  // ⚠️ **排気量が指定されたら costing もそれで決める。**
  //    50cc に motorcycle を使うと高速に乗る経路が出る
  const bike = DISPLACEMENTS[opts.displacement] || null;
  const costing = opts.costing || (bike ? bike.costing : "motor_scooter");
  // ⚠️ costing ごとの設定を選ぶ。無ければ空（既定のまま）
  const variantOptions = { ...(variant[costing] || {}) };

  // ⚠️ **重ねる順番を変えないこと。** 案の作り分け → 画面の回避指定 →
  //    最後に法令由来の制約。**画面の指定で法令を緩められてはいけない。**
  if (opts.avoidHighways) variantOptions.use_highways = 0;
  if (opts.avoidTolls) variantOptions.use_tolls = 0;
  if (bike && !bike.canUseExpressway) variantOptions.use_highways = 0;
  // ⚠️ **重なった経由地をまとめること。** 同じ点が続くと Valhalla が
  //    `leg_shape_index not set for intermediate location` で失敗する。
  //    実測: 陣馬街道の出口と和田林道の入口が**0m**（同じ交差点）で、
  //    8本通そうとした案が丸ごと引けなくなっていた。
  //    ⚠️ 端点（出発地・目的地）は消さない。消すと行き先が変わる。
  const MIN_VIA_GAP_METERS = 25;
  const vias = [];
  for (const p of (opts.vias || [])) {
    const last = vias[vias.length - 1];
    if (last && metersBetween(last, p) < MIN_VIA_GAP_METERS) continue;
    vias.push(p);
  }
  const locations = [
    { lat: from[1], lon: from[0] },
    ...vias.map((p) => ({ lat: p[1], lon: p[0], type: "through" })),
    { lat: to[1], lon: to[0] },
  ];
  const body = {
    locations,
    costing,
    units: "kilometers",
    // ⚠️ **決め打ちにしないこと。** 海外の地域を足したとき、ここが日本語のままだと
    //    その国の言語で返らない。Valhalla 側は admins.sqlite の
    //    default_language / supported_languages を持っているので、渡せば従う
    language: opts.language || DEFAULT_LANGUAGE,
    costing_options: { [costing]: variantOptions },
  };
  if (opts.excludePolygons && opts.excludePolygons.length) {
    body.exclude_polygons = opts.excludePolygons;
  }

  let json;
  try {
    // ⚠️ **URLを固定しないこと。** 地域ごとに Valhalla を分ける前提
    //    （惑星規模のタイルは作れないので、地域ごとのサービスになる）
    const res = await fetch(`${opts.baseUrl || BASE}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    json = await res.json();
  } catch (e) {
    // ⚠️ 立ち上がっていないのが圧倒的に多い。原因が分かる文言にする
    return { error: `Valhalla に繋がりません（${opts.baseUrl || BASE}）。`
      + "docker run -d --name valhalla-jp -p 8002:8002 valhalla-jp-cloudrun:latest "
      + `で立ち上げてください / ${e.message}` };
  }
  if (!json || !json.trip) {
    const message = (json && json.error) || "経路が返りませんでした";
    return { error: String(message) };
  }

  const trip = json.trip;
  const points = [];
  const steps = [];
  for (const leg of trip.legs) {
    // ⚠️ 区間ごとに shape が別々。区間をまたぐ番号として使えないので、
    //    いまの points の長さを足してから記録する
    const offset = points.length;
    const shape = decode6(leg.shape);
    for (const p of shape) {
      const tail = points[points.length - 1];
      if (!tail || tail[0] !== p[0] || tail[1] !== p[1]) points.push(p);
    }
    for (const m of leg.maneuvers) {
      steps.push({
        maneuver: MANEUVER[m.type] || "straight",
        valhallaType: m.type,
        instruction: m.instruction || "",
        roadName: (m.street_names || []).join("／"),
        distanceMeters: Math.round((m.length || 0) * 1000),
        durationSeconds: Math.round(m.time || 0),
        beginIndex: offset + (m.begin_shape_index || 0),
        endIndex: offset + (m.end_shape_index || 0),
        // ⚠️ **道の種別は Valhalla が maneuver ごとに教えてくれる。**
        //    道路名から「自動車道」を探すような当て推量をしないこと
        //    （実測: highway 3区間65.9km / toll 7区間70.6km を正しく拾えた）
        roadKind: m.highway ? "expressway" : (m.toll ? "toll" : "surface"),
      });
    }
  }

  return {
    variant: opts.variant || "normal",
    // ⚠️ **表示名は返さない。** 呼ぶ側が作る。ここで日本語を返すと、
    //    APIを外に出したときに日本語が混ざる（`variant` は鍵なので言語に依存しない）
    costing,
    //: 実際に効いた設定（画面で確かめられるように）
    costingOptions: variantOptions,
    displacement: opts.displacement || null,
    lengthMeters: Math.round(trip.summary.length * 1000),
    durationSeconds: Math.round(trip.summary.time),
    points,
    polyline: encode(points),     // 5桁。このツールの他の線と揃える
    steps,
    uTurns: steps.filter((s) => s.maneuver.startsWith("uturn")).length,
    // ⚠️ 「ふつう」がほぼ高速だった、のような事故に気づけるよう内訳を返す
    //    （実測: バイクの「ふつう」は77.8km中65.9kmが高速だった）
    kindMeters: steps.reduce((acc, x) => {
      acc[x.roadKind] += x.distanceMeters;
      return acc;
    }, { expressway: 0, toll: 0, surface: 0 }),
  };
}

module.exports = { routeWithValhalla, decode6, MANEUVER, VARIANTS, DISPLACEMENTS, BASE };
