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

const { spokenRoadName, intersectionName } = require("./navName");
const { shouldSayFollowTheRoad } = require("./navGuide");
const { applicable: applicableRestrictions, hitsOnRoute, excludePolygonsFor }
  = require("./restrictionAvoid");

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
/* ⚠️ **道路クラスの重みはここに書かない。** `ROAD_CLASS_TIERS` が持つ。
      両方に書くと二重になり、片方を消しても効いてしまう（実際に踏んだ）。
      ここには「クラス以外の、案ごとの設定」だけを置く。 */
const VARIANTS = {
  shortest: {
    motor_scooter: { shortest: true },
    motorcycle:    { shortest: true },
  },
  normal: {
    motor_scooter: {},
    motorcycle:    {},
  },
  fun: {
    motor_scooter: {},
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
 * 【`top_speed` について】
 * Valhalla の `top_speed` は2つを同時にやる:
 *   (a) その速度で走ったものとして所要時間を出す
 *   (b) それより速い道に**罰を与える**（禁止ではない）
 *
 * ⚠️ **以前ここには「30を渡すと60km/hの一般道をほぼ全部避けるので入れない」と
 *    書いてあったが、実測すると言い過ぎだった。** 5区間で測り直した結果、
 *    `top_speed: 30` でも主要地方道を16〜30%使っており、距離の増えかたも
 *    最大+7%（新座→愛川は49.0km→49.0kmで変化なし）。**禁止ではなく傾きにすぎない。**
 *    ⚠️ ただし「楽しさのつまみ」として使うのは変わらず駄目
 *    （VARIANTS の注意書き参照）。使うのは**排気量ごとの走り方**を表すときだけ。
 *
 * 【所要時間が正しくなる】
 *   原付一種 新座→愛川 49km: 80分（37km/h＝ありえない）→ 105分（28km/h）
 */
const DISPLACEMENTS = {
  // 法定30km/h・二段階右折。幹線を流れに乗って走れないので生活道路寄り
  moped50:   { costing: "motor_scooter", canUseExpressway: false, topSpeed: 30 },
  // 法定60km/h・二段階右折なし。クルマの流れに乗れるので幹線寄り
  small125:  { costing: "motor_scooter", canUseExpressway: false, topSpeed: 60 },
  // ⚠️ **motorcycle は道路クラスのつまみが一切効かない**（下の注意書き参照）。
  //    既定で主要地方道65〜67%と、もともと幹線寄りに走る
  medium250: { costing: "motorcycle",    canUseExpressway: true },
  large:     { costing: "motorcycle",    canUseExpressway: true },
};

/**
 * 道路クラスごとの重み。GenNavi（OSMカンファレンス発表）と同じ考え方。
 *
 * 【スライドの表】
 *              幹線 primary   生活道路 residential
 *   最短        0.9 使う       0.05 使わない
 *   推奨        ちょうどいいバランス
 *   裏道        0.1 避ける     1.0 優先
 *
 * ⚠️ **Valhalla に `use_residential` は無い。** `use_primary` が
 *    「幹線を使うか、それとも secondary/tertiary/unclassified へ落とすか」を
 *    まとめて決めるので、実質これ1つで表の左右が決まる。
 *
 * ⚠️ **`use_living_streets` は入れない。** 3区間で試して**経路が1mも変わらなかった**
 *    （`highway=living_street` は日本にほとんど無い。`residential` とは別物）。
 *
 * 【実測（曲率 度/km）】
 *                      新座→愛川      甲府→富士吉田    高崎→草津
 *   最短 0.9           46.0km/132    36.4km/140    62.3km/179
 *   推奨 0.5           49.0km/124    37.6km/236    66.1km/259
 *   裏道 0.05          48.2km/165    40.4km/253    72.5km/363
 *
 * ⚠️ **これが効くのは `motor_scooter` だけ。** `motorcycle` では
 *    `use_primary` を振っても経路が変わらない。8通り試して
 *    （use_primary 0/1・use_living_streets 0・use_tracks 0・use_trails 0・
 *      service_penalty 500・top_speed 100）**すべて同じ経路**だった
 *      （新座→愛川 51.8km/70分・甲府→富士吉田 37.6km/47分がぴったり一致）。
 *    motorcycle で効くのは `use_highways` / `use_tolls` / `shortest` だけ。
 *
 * 【排気量で向きが逆になる】
 * ⚠️ **同じ「ふつう」でも、原付一種と原付二種では選ぶ道が違う。**
 *      原付一種（50cc以下）… 法定30km/h・二段階右折。幹線は流れに乗れず危ない
 *      原付二種（125cc以下）… 法定60km/h・二段階右折なし。幹線の方が安全で速い
 *    以前は両方とも同じ設定だったので、**画面で選び分けても経路が1mも変わらなかった。**
 *
 * 【実測（5区間・高速回避・おすすめ道路なし。大きい道＝高速+幹線+主要地方道）】
 *                    新座→愛川   甲府→富士  高崎→草津  名古屋→伊勢  福岡→阿蘇
 *   原付一種 いま      56%       76%      66%      71%       23%
 *   原付一種 案        18%       55%      58%      58%       21%
 *   原付二種 いま      56%       76%      66%      71%       23%
 *   原付二種 案        88%       76%      79%      79%       53%
 *   軽二輪・大型       65%       76%      84%      99%       65%
 */
const ROAD_CLASS_TIERS = {
  // 原付一種（50cc以下）: 生活道路寄り
  moped50:  { shortest: { use_primary: 0.3 },
              normal:   { use_primary: 0.05 },
              fun:      { use_primary: 0 } },
  // 原付二種（125cc以下）: 幹線寄り
  small125: { shortest: { use_primary: 1 },
              normal:   { use_primary: 0.9 },
              fun:      { use_primary: 0.3 } },
  // 排気量が指定されていないとき。以前の値をそのまま残してある
  // ⚠️ 軽二輪・大型はここに来ない（`motorcycle` costing では何も効かない）
  default:  { shortest: { use_primary: 0.9 },
              normal:   { use_primary: 0.5 },
              fun:      { use_primary: 0.05 } },
};

/**
 * 「高速に乗らない」を叶えるための `use_highways` の段階。
 *
 * ⚠️ **`use_highways: 0` は高速だけでなく国道（`trunk`）も捨てる。**
 *    Valhalla は motorway を1.0倍、trunk を0.5倍で罰する。日本の `trunk` は
 *    国道の主要区間なので、0にすると**国道を避けて裏道へ逃げる**。
 *    実測（新座→愛川の終盤、鳥屋川尻線の出口→愛川 直線1.5km）:
 *      use_highways 0    → 2.59km・指示14・生活道路1.26km（国道412号を3回出入り）
 *      渡さない          → 2.23km・指示 2・幹線2.23km（412号を直進）
 *    利用者から「大きな道路があるのにわざわざ狭い道路に出る」と報告された形。
 *
 * ⚠️ **単一の値では両立しない。** 12区間で振ったところ、
 *      0.1  … 高速の漏れ0件だが、上の終盤は1mも変わらない
 *      0.3  … 上の終盤は直る（幹線2.23km）が、東京→箱根で高速37kmが混ざる
 *    **区間ごとに答えが違う。**
 *
 * 【なので、緩い方から試して高速が混ざらない一番ゆるい値を採る】
 *    実測（楽しい案・大型・8区間）:
 *      固定 0            距離1151km 幹線 82km **細い道138.8km** 呼出1.00回/区間
 *      段階 0.3/0.15/0   距離1129km 幹線163km **細い道 75.9km** 呼出1.50回/区間
 *    細い道が45%減り、国道が倍になる。高速は全区間0kmのまま。
 *
 * ⚠️ **判定に `/trace_attributes` は要らない。** maneuver の `highway` で分かるので
 *    追加の通信が増えない。増えるのは `/route` だけ（実測 1.50回/区間）。
 *
 * ⚠️ **`motor_scooter` では使わない。** あちらは `use_highways` を完全に無視する
 *    （0でも1でも同じ経路。5区間で高速0.0kmのまま）。
 *    50cc/125cc が高速に乗らないのは costing の作りによる保証であって、
 *    この値のおかげではない。
 */
const HIGHWAY_LADDER = [0.3, 0.15, 0];

/**
 * 目的地を「渡らずに着ける側」にするために、どこまで遠回りを許すか。
 *
 * ⚠️ **実測で、はっきり2つに割れる。** 12地点の追加距離:
 *      0.00 / 0.00 / 0.00 / 0.00 / 0.00 / 0.00 / 0.15 / 0.15 / 0.28 / 0.35 / 0.40 / **29.06** km
 *    上11件は「街区を回る」程度。最後の1件（仙台→蔵王）は左側に着けるために
 *    **71km → 100km・往復28.9km** になった。あいだが空いているので 2km で切る。
 */
const MAX_SIDE_DETOUR_METERS = 2_000;

/**
 * 船（フェリー）を使わせないための設定。
 *
 * ⚠️ **`use_ferry: 0` だけでは足りない。** `shortest: true` を渡すと Valhalla は
 *    距離だけで経路を決め、**時間まわりの重みを全部無視する**ので `use_ferry` も
 *    `ferry_cost` も効かなくなる。船は地図の上ではまっすぐで短いため、
 *    最短の案は必ず船に乗る。実測（東京→秋田）:
 *      shortest なし  583.9km  6.3時間  船  0.0km
 *      shortest あり  557.7km 12.8時間  船229.5km（新日本海フェリー 新潟－秋田）
 *    **26km縮めるために6.5時間よけいに掛かる。** 利用者から報告された形。
 *    ⚠️ 効かないのは shortest のときだけ。船を避けられる区間で確かめてある
 *      （横須賀→館山 ふつう: 47km船12km → `use_ferry:0` で 123km船0km）。
 *
 * 【なので、船が出たらその場所を塞いで引き直す】
 * ⚠️ **`exclude_polygons` は `shortest` でも効く。** 唯一効く手段。
 * ⚠️ **四角の合計の周囲に上限がある**（10,000m）。±0.005度の四角は3個で超える
 *    （実測: `Exceeded maximum circumference for exclude_polygons`）。
 *    ±0.002度（周囲およそ1.6km）なら3個入る。
 * ⚠️ **いたちごっこになる。** 1本塞ぐと別の航路が出る
 *    （東京→高松: ジャンボフェリー → 伊勢湾フェリー → 小豆島急行フェリー）。
 *    3回で駄目なら **`shortest` を諦める**（そちらは `use_ferry: 0` が効く）。
 *
 * 【実測（最短の案）】
 *   東京→秋田    559km 船0km（2回）      横須賀→館山  114km 船0km（2回）
 *   東京→高松    672km 船0km（4回）      東京→鹿児島 1357km 船0km（5回・shortestを諦めた）
 *   東京→札幌   船39km（青函は避けられない）  東京→那覇  船681km（同上）
 *   新座→愛川   船なしなので1回のまま
 *
 * ⚠️ **消せない航路がある。** 北海道・沖縄へは船なしで行けない。
 *    そのときは黙って遠回りせず、船が残ったことを返す（画面に出す）。
 */
const FERRY_EXCLUDE_DEGREES = 0.002;
const FERRY_EXCLUDE_TRIES = 3;
/** Valhalla の maneuver: 28 = フェリーに乗る */
const FERRY_MANEUVER = 28;

/**
 * 二輪の通行規制を避けるために、何回まで引き直すか。
 *
 * ⚠️ **引いてから避けること。** `exclude_polygons` は周囲の合計に上限があり
 *    （Valhalla の `max_exclude_polygons_length`、既定10,000m）、県内の規制を
 *    全部渡すことはできない。掛かったものだけ塞げば、実測で1件あたり
 *    9個・1,800m に収まった（芦ノ湖スカイライン10km級）。
 * ⚠️ **塞ぐと別の規制に掛かることがある。** 数回で打ち切り、残ったことは返す。
 */
const MAX_RESTRICTION_TRIES = 3;

/**
 * 道路クラスの色（スライドと同じ並び）。
 * ⚠️ 鍵は Valhalla の `edge.road_class` に合わせる。勝手に増やさないこと。
 */
const ROAD_CLASS_COLORS = {
  motorway:      "#c92a2a",
  trunk:         "#e8590c",
  primary:       "#f08c00",
  secondary:     "#fab005",
  tertiary:      "#82c91e",
  unclassified:  "#2b8a3e",
  residential:   "#1c7ed6",
  service_other: "#868e96",
};

/**
 * 経路の線を、道路クラスごとに切り分ける。
 *
 * ⚠️ **`/route` の応答にはクラスが入っていない。** maneuver が持つのは
 *    `highway` / `toll` の真偽だけ。クラスは `/trace_attributes` に
 *    同じ線を渡して取る（実測 401辺で21ms）。
 * ⚠️ 失敗しても経路は返すこと。色が付かないだけで、線は使える。
 */
/**
 * 経路の線を、道路クラスごとの区間に割る。
 *
 * ⚠️ **`edge_walk` は高速を通る経路で失敗する。** 実測: 新座→愛川の「ふつう」
 *    （77.8km・うち高速65.8km）で `error_code 443`
 *    「edge_walk algorithm failed to find exact route match」を返し、
 *    色分けが**黙って消えていた**（画面のクラス内訳が全部0kmになる）。
 *    Valhalla のエラー文自身が `walk_or_snap` への切り替えを勧めている。
 *    ⚠️ **速い方を先に試すこと。** `edge_walk` 17ms に対し
 *    `walk_or_snap` は137ms（地図合わせをやり直すぶん重い）。
 */
/**
 * 経路の線を、**都道府県ごと**の区間に割る。
 *
 * 【なぜ要るか】
 * 「県道36号線」と読み上げるため。⚠️ **東京で「県道」と言ってはいけない**（都道）。
 *   東京都 → 都道 ／ 北海道 → 道道 ／ 京都府・大阪府 → 府道 ／ ほか → 県道
 *
 * ⚠️ **`edge.end_node.admin_index` は `node.admin_index` を頼まないと入らない。**
 *    `edge.end_node.admin_index` と書いて頼んでも undefined が返る（実測）。
 * ⚠️ 番号は `admins` の並びへの添字。`admins` は経路が通った順ではなく
 *    **出てきた順**なので、必ず添字で引くこと。
 *
 * ⚠️ **200kmを超える経路では何も返らない。** `trace_attributes` の上限
 *    （`Path distance exceeds the max distance limit: 200000 meters`）。
 *    そのときは `step.prefecture` が null になり、道路名は番号の形に直せず
 *    路線名のまま読まれる（落ちはしない）。**規制の県決めには使わないこと。**
 *
 * 【実測】東京→箱根（下道93km・1,520辺）で **30ms**。
 *        `admins` は [{state_text:"東京都"},{state_text:"神奈川県"}] が返る。
 */
async function adminSpans(encodedShape, costing, baseUrl) {
  try {
    const res = await fetch(`${baseUrl || BASE}/trace_attributes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encoded_polyline: encodedShape,
        costing,
        shape_match: "walk_or_snap",
        filters: {
          attributes: ["node.admin_index", "admin.state_text",
                       "edge.begin_shape_index", "edge.end_shape_index"],
          action: "include",
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json();
    if (!json || !Array.isArray(json.edges) || !Array.isArray(json.admins)) return null;
    const spans = [];
    for (const e of json.edges) {
      const state = (json.admins[(e.end_node || {}).admin_index] || {}).state_text || null;
      const last = spans[spans.length - 1];
      if (last && last.state === state) { last.end = e.end_shape_index; continue; }
      spans.push({ state, begin: e.begin_shape_index, end: e.end_shape_index });
    }
    return spans;
  } catch (e) {
    return null;          // 県が分からないだけ。経路は返す
  }
}

async function roadClassSpans(encodedShape, costing, baseUrl) {
  const ask = async (shapeMatch) => {
    const res = await fetch(`${baseUrl || BASE}/trace_attributes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encoded_polyline: encodedShape,
        costing,
        shape_match: shapeMatch,
        filters: {
          attributes: ["edge.road_class", "edge.length",
                       "edge.begin_shape_index", "edge.end_shape_index"],
          action: "include",
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.json();
  };

  try {
    let json = await ask("edge_walk");
    if (!json || !Array.isArray(json.edges)) json = await ask("walk_or_snap");
    if (!json || !Array.isArray(json.edges)) return null;
    // 隣り合う同じクラスをつなげて、線の数を減らす
    const spans = [];
    for (const e of json.edges) {
      const last = spans[spans.length - 1];
      if (last && last.roadClass === e.road_class) {
        last.end = e.end_shape_index;
        last.meters += Math.round((e.length || 0) * 1000);
      } else {
        spans.push({ roadClass: e.road_class,
                     begin: e.begin_shape_index, end: e.end_shape_index,
                     meters: Math.round((e.length || 0) * 1000) });
      }
    }
    return spans;
  } catch (e) {
    return null;     // 色が付かないだけ。経路は返す
  }
}

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

  // ⚠️ **道路クラスの重みが効くのは motor_scooter だけ。**
  //    motorcycle に混ぜても経路が変わらないので入れない（無駄な設定を増やさない）
  // ⚠️ **排気量で選び、次に案（最短/ふつう/楽しい）で選ぶ。** 順番が逆だと
  //    「原付一種なのに幹線ばかり」になる
  if (costing === "motor_scooter" && opts.roadClassTier !== false) {
    const tier = ROAD_CLASS_TIERS[opts.displacement] || ROAD_CLASS_TIERS.default;
    Object.assign(variantOptions, tier[opts.variant] || tier.normal);
  }
  // ⚠️ **排気量ごとの走り方。** 所要時間もこれで正しくなる（DISPLACEMENTS 参照）
  if (bike && bike.topSpeed) variantOptions.top_speed = bike.topSpeed;

  // ⚠️ **船に乗せない。** `shortest` のときは効かないので、下で塞ぎ直す
  //    （FERRY_EXCLUDE_DEGREES の説明を読むこと）
  variantOptions.use_ferry = 0;
  variantOptions.use_rail_ferry = 0;

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
  const destination = { lat: to[1], lon: to[0] };
  const locations = [
    { lat: from[1], lon: from[0] },
    ...vias.map((p) => ({ lat: p[1], lon: p[0], type: "through" })),
    destination,
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

  const ask = async () => {
    // ⚠️ **URLを固定しないこと。** 地域ごとに Valhalla を分ける前提
    //    （惑星規模のタイルは作れないので、地域ごとのサービスになる）
    const res = await fetch(`${opts.baseUrl || BASE}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.json();
  };
  /** その経路が高速・自動車専用道を通っているか。maneuver の `highway` で見る */
  const ridesExpressway = (t) =>
    (t.legs || []).some((leg) => (leg.maneuvers || []).some((m) => m.highway));

  /** 経路の点。規制と重なっているかを測るのに使う */
  const pointsOfTrip = (t) => (t.legs || []).flatMap((leg) => decode6(leg.shape));
  const perimeterOfRings = (rings) => rings.reduce((a, r) => a + perimeterOfRing(r), 0);
  const perimeterOfRing = (ring) => {
    let total = 0;
    for (let i = 1; i < ring.length; i++) {
      const dLat = (ring[i][1] - ring[i - 1][1]) * 110540;
      const dLng = (ring[i][0] - ring[i - 1][0]) * 111320
        * Math.cos(((ring[i][1] + ring[i - 1][1]) / 2) * Math.PI / 180);
      total += Math.hypot(dLat, dLng);
    }
    return total;
  };

  /** その経路が船に乗っているか */
  const ridesFerry = (t) => ferryMetersOf(t) > 0;
  const ferryMetersOf = (t) => (t.legs || []).reduce((a, leg) =>
    a + (leg.maneuvers || []).filter((m) => m.type === FERRY_MANEUVER)
      .reduce((b, m) => b + (m.length || 0) * 1000, 0), 0);
  /** 点のまわりの小さな四角。ここを通れなくする */
  const boxAround = (p) => {
    const d = FERRY_EXCLUDE_DEGREES;
    return [[p[0] - d, p[1] - d], [p[0] + d, p[1] - d],
            [p[0] + d, p[1] + d], [p[0] - d, p[1] + d], [p[0] - d, p[1] - d]];
  };
  /** 最初に出てくる船の、まんなかの点 */
  const ferryMidpoint = (t) => {
    for (const leg of t.legs || []) {
      const m = (leg.maneuvers || []).find((x) => x.type === FERRY_MANEUVER);
      if (!m) continue;
      const shape = decode6(leg.shape);
      return shape[Math.floor(((m.begin_shape_index || 0)
                             + (m.end_shape_index || 0)) / 2)] || null;
    }
    return null;
  };

  let json;
  let highwayTries = 1;
  let ferryTries = 1;
  let sideTried = false;
  let sideGaveUp = false;
  let restrictionTries = 0;
  let restrictionHits = [];
  let restrictionSkipped = [];
  /** 規制を読んだ県。⚠️ 見落としが起きていないか確かめるために返す */
  let restrictionPrefectures = [];
  try {
    json = await ask();

    // ⚠️ **船に乗ってしまったら、その場所を塞いで引き直す。**
    //    `shortest` では `use_ferry` が効かないため（上の説明を読むこと）
    if (json && json.trip && ridesFerry(json.trip)) {
      const handPolygons = body.exclude_polygons || [];
      let best = json;
      const boxes = [];
      for (let i = 0; i < FERRY_EXCLUDE_TRIES && ridesFerry(best.trip); i++) {
        const mid = ferryMidpoint(best.trip);
        if (!mid) break;
        boxes.push(boxAround(mid));
        body.exclude_polygons = [...handPolygons, ...boxes];
        ferryTries++;
        const next = await ask();
        if (!next || !next.trip) break;      // 塞ぎすぎて引けない。前のを使う
        if (ferryMetersOf(next.trip) < ferryMetersOf(best.trip)) best = next;
        else break;                          // 減らないなら、いたちごっこ。打ち切る
      }
      // ⚠️ **それでも残るなら `shortest` を諦める。** そちらは `use_ferry` が効く
      if (ridesFerry(best.trip) && variantOptions.shortest) {
        body.exclude_polygons = handPolygons;
        const { shortest, ...noShortest } = variantOptions;
        body.costing_options[costing] = noShortest;
        ferryTries++;
        const plain = await ask();
        if (plain && plain.trip && ferryMetersOf(plain.trip) < ferryMetersOf(best.trip)) {
          best = plain;
          delete variantOptions.shortest;
        } else {
          body.costing_options[costing] = variantOptions;
          body.exclude_polygons = [...handPolygons, ...boxes];
        }
      }
      if (!body.exclude_polygons || !body.exclude_polygons.length) {
        delete body.exclude_polygons;
      }
      json = best;
    }

    // ⚠️ **高速を外すために国道まで捨てない。** 緩い方から試して、
    //    高速が混ざらない一番ゆるい値を採る（HIGHWAY_LADDER の説明を読むこと）
    if (json && json.trip && costing === "motorcycle"
        && opts.highwayLadder !== false
        && variantOptions.use_highways === 0) {
      for (const level of HIGHWAY_LADDER) {
        if (level === 0) break;                       // 0 は既に引いてある
        body.costing_options[costing] = { ...variantOptions, use_highways: level };
        highwayTries++;
        const loose = await ask();
        // ⚠️ 緩めたせいで船に乗り直すことがある。高速と同じく受け入れない
        if (loose && loose.trip && !ridesExpressway(loose.trip)
            && ferryMetersOf(loose.trip) <= ferryMetersOf(json.trip)) {
          json = loose;
          variantOptions.use_highways = level;
          break;
        }
      }
      body.costing_options[costing] = variantOptions;
    }

    // ⚠️ **二輪が通れない道を避ける。** 引いてから、掛かったところだけ塞いで引き直す
    //    （MAX_RESTRICTION_TRIES の説明を読むこと）
    if (json && json.trip && (opts.restrictionsFor || opts.restrictions)) {
      // ⚠️ **県は「引いてから」決めること。**
      //    規制を渡すには県が要るが、県を知るには経路が要る（鶏と卵）。
      //    ⚠️ **両端の県だけでは足りない。** 実測: 東京→大阪の両端は
      //       [東京都, 大阪府] だが、実際に通るのは8県。**6県ぶんの規制を見落とす。**
      //       東京→箱根・名古屋→伊勢では0件なので、**短い区間で試している限り気づけない。**
      //    ⚠️ `segmentsBetween` の `prefectures` は使わないこと。あれはおすすめ道路を
      //       集めるための広い円で、東京→大阪で **35県**を返す（実際に通るのは8県）。
      //    Valhalla 自身が経路の通る県を返す（`adminSpans`。実測30ms）ので、それを使う。
      let list = opts.restrictions;
      if (opts.restrictionsFor) {
        // ⚠️ **どの県かの判断は呼び出し側に任せる。** ここでは経路の点だけ渡す。
        //    ⚠️ Valhalla の `adminSpans` は使えない。`trace_attributes` に
        //       **200kmの上限**があり、長距離だと
        //       「Path distance exceeds the max distance limit: 200000 meters」で
        //       何も返らない（実測: 東京→大阪561kmで0県になった）。
        const found = await opts.restrictionsFor(pointsOfTrip(json.trip));
        list = (found && found.restrictions) || found || [];
        restrictionPrefectures = (found && found.prefectures) || [];
      }
      const rules = applicableRestrictions(list || [], {
        displacement: opts.displacement, at: opts.at, isHoliday: opts.isHoliday,
      });
      if (rules.length) {
        const handPolygons = body.exclude_polygons || [];
        const boxes = [];
        for (let i = 0; i < MAX_RESTRICTION_TRIES; i++) {
          const hits = hitsOnRoute(pointsOfTrip(json.trip), rules);
          // ⚠️ **`verified` を落とさないこと。** 落とすと未確認（JARTIC の候補）を
          //    避けたのか、人が地図で見て登録したものを避けたのかが見る側に伝わらない
          //    （実際に落としていて、未確認がすべて「確認済」に見えていた）
          restrictionHits = hits.map((h) => ({
            id: h.id, name: h.name, ratio: h.ratio, verified: h.verified !== false }));
          if (!hits.length) break;
          const made = excludePolygonsFor(hits, {
            // ⚠️ 既に船で使っているぶんを差し引く。合計で上限に当たる
            maxPerimeterMeters: 10_000 - perimeterOfRings(boxes),
          });
          restrictionSkipped = made.skipped.map((h) => ({ id: h.id, name: h.name }));
          if (!made.polygons.length) break;      // これ以上は塞げない。残ったまま返す
          boxes.push(...made.polygons);
          body.exclude_polygons = [...handPolygons, ...boxes];
          restrictionTries++;
          const avoided = await ask();
          if (!avoided || !avoided.trip) {
            // ⚠️ 塞ぎすぎて引けない。**塞ぐ前を返す**（経路が無いより通れない道のほうがまし）
            boxes.length = 0;
            body.exclude_polygons = handPolygons.length ? handPolygons : undefined;
            if (!body.exclude_polygons) delete body.exclude_polygons;
            break;
          }
          json = avoided;
        }
      }
    }

    // ⚠️ **目的地を「渡らずに着ける側」にする。** 日本は左側通行なので**左側**に着く。
    //    ⚠️ **「左」と決め打ちしないこと。** 向きは Valhalla が国ごとに持っている
    //       （admins.sqlite の `drive_on_right`）。決め打ちすると右側通行の国で全部逆になる。
    //       `same` は「走っている側と同じ」の意味。
    //    ⚠️ **効かないことがある。** 目的地が道の中心線の真上や、交差点がいちばん
    //       近いときは Valhalla 側が無視する（実測12地点中2地点で `side_of_street` が空）。
    //    ⚠️ **遠回りが大きいときは諦めること。** 実測12地点の追加距離は
    //       0.00 / 0.00 / 0.00 / 0.00 / 0.00 / 0.00 / 0.15 / 0.15 / 0.28 / 0.35 / 0.40 / **29.06** km。
    //       仙台→蔵王は左側に着けるために **71km → 100km（往復28.9km）** になった。
    //       「街区を回る」と「山を回る」のあいだがはっきり空いているので 2km で切る。
    if (json && json.trip && opts.arriveOnNearSide) {
      destination.preferred_side = "same";
      sideTried = true;
      const sided = await ask();
      const base = json.trip.summary.length * 1000;
      if (sided && sided.trip
          && sided.trip.summary.length * 1000 <= base + MAX_SIDE_DETOUR_METERS
          && ferryMetersOf(sided.trip) <= ferryMetersOf(json.trip)) {
        json = sided;
      } else {
        // ⚠️ 諦めたことが分かるようにする（画面で「左に着かない理由」が見える）
        sideGaveUp = true;
        delete destination.preferred_side;
      }
    }
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
        // ⚠️ **表示用。** 番号もローマ字も全部つなげてある。読み上げには使わない
        roadName: (m.street_names || []).join("／"),
        // ⚠️ **読み上げ名を後から決め直すために持ち回る。**
        //    `roadName` では足りない（`begin_street_names` が落ちる）
        roadNames: [...new Set([...(m.begin_street_names || []),
                                ...(m.street_names || [])])],
        // ⚠️ **読み上げ用は別。** 番号の形（「県道21号線」）に直すこともある。
        //    ⚠️ **県が分かってからでないと決められない**ので、下の admin の後で入れる
        spokenRoad: null,
        // 生の名前。読み上げ名を決め直すために持ち回る
        _maneuver: m,
        // ⚠️ 交差点名は `sign` に入らない。読み上げ文の中から取り出している
        intersectionName: intersectionName(m),
        // ⚠️ **曲がりくねった道で「直進します」と言わないための印。**
        //    この指示のあいだに走る線の曲率で決める（250度/km以上）
        isCurvyAhead: shouldSayFollowTheRoad(
          shape.slice(m.begin_shape_index || 0, (m.end_shape_index || 0) + 1)),
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

  // ⚠️ 区間が複数あるときは先頭だけ。色分けは目で見るためのものなので、
  //    全部を繋ぐ手間に見合わない（経由地を through にしているので通常1区間）
  // ⚠️ **読み上げに要る**（「県道36号線」の「県道」）。切るときは
  //    `withAdmins: false` を渡すこと。実測30msなので既定では取る
  const admins = opts.withAdmins === false ? null
    : await adminSpans(trip.legs[0].shape, costing, opts.baseUrl);
  if (admins) {
    for (const step of steps) {
      const span = admins.find((a) => step.beginIndex >= a.begin && step.beginIndex <= a.end)
        || admins.find((a) => step.beginIndex <= a.end);
      step.prefecture = span ? span.state : null;
    }
  }
  // ⚠️ **県が決まってから読み上げ名を決める**（「県道」か「都道」かが変わる）
  for (const step of steps) {
    step.spokenRoad = spokenRoadName(step._maneuver,
      { prefecture: step.prefecture, style: opts.roadNameStyle });
    delete step._maneuver;
  }

  let classSpans = opts.withRoadClass === false ? null
    : await roadClassSpans(trip.legs[0].shape, costing, opts.baseUrl);
  // ⚠️ **番号を線の範囲に収めること。** `/trace_attributes` は最後の辺の
  //    `end_shape_index` に「点の数」を返すことがあり（実測: 線1,203点に対し1203）、
  //    そのまま slice すると末尾が1点足りない線になる。
  //    ⚠️ points は区間をつなぐときに重複を落としているので、
  //    trace 側の番号とは1つずれうる。ここで必ず丸める
  if (classSpans) {
    const lastIndex = points.length - 1;
    classSpans = classSpans.map((sp) => ({
      ...sp,
      begin: Math.max(0, Math.min(sp.begin, lastIndex)),
      end: Math.max(0, Math.min(sp.end, lastIndex)),
    })).filter((sp) => sp.end > sp.begin);
  }

  return {
    variant: opts.variant || "normal",
    // ⚠️ **表示名は返さない。** 呼ぶ側が作る。ここで日本語を返すと、
    //    APIを外に出したときに日本語が混ざる（`variant` は鍵なので言語に依存しない）
    costing,
    //: 実際に効いた設定（画面で確かめられるように）
    costingOptions: variantOptions,
    // ⚠️ 何回引き直したか。画面で「国道を通すために緩めた」が見えるように
    highwayTries,
    // 船を外すために何回引き直したか／それでも残った船の距離（避けられない航路）
    ferryTries,
    ferryMeters: Math.round(ferryMetersOf(trip)),
    // 規制を避けるために何回引き直したか／それでも残った規制
    restrictionTries,
    // ⚠️ **残ったものは黙って捨てない。** 画面とアプリで警告に使う
    restrictionHits,
    restrictionSkipped,
    restrictionPrefectures,
    // 目的地のどちら側に着いたか（"left" / "right" / null）。
    // ⚠️ 指定しても null で返ることがある（上の注意書き参照）
    arrivedSide: ((trip.locations || [])[(trip.locations || []).length - 1] || {})
      .side_of_street || null,
    // 側の指定を試したか／遠回りが大きすぎて諦めたか
    sideTried, sideGaveUp,
    displacement: opts.displacement || null,
    lengthMeters: Math.round(trip.summary.length * 1000),
    durationSeconds: Math.round(trip.summary.time),
    points,
    polyline: encode(points),     // 5桁。このツールの他の線と揃える
    steps,
    uTurns: steps.filter((s) => s.maneuver.startsWith("uturn")).length,
    // ⚠️ 「ふつう」がほぼ高速だった、のような事故に気づけるよう内訳を返す
    //    （実測: バイクの「ふつう」は77.8km中65.9kmが高速だった）
    //: 道路クラスごとの区間（色分け用）。取れなければ null
    classSpans,
    //: クラスごとの距離
    classMeters: (classSpans || []).reduce((acc, sp) => {
      acc[sp.roadClass] = (acc[sp.roadClass] || 0) + sp.meters;
      return acc;
    }, {}),
    kindMeters: steps.reduce((acc, x) => {
      acc[x.roadKind] += x.distanceMeters;
      return acc;
    }, { expressway: 0, toll: 0, surface: 0 }),
  };
}

module.exports = { routeWithValhalla, decode6, MANEUVER, VARIANTS, DISPLACEMENTS,
  ROAD_CLASS_TIERS, ROAD_CLASS_COLORS, HIGHWAY_LADDER, MAX_SIDE_DETOUR_METERS,
  adminSpans,
  FERRY_EXCLUDE_DEGREES, FERRY_EXCLUDE_TRIES, FERRY_MANEUVER,
  roadClassSpans, BASE };
