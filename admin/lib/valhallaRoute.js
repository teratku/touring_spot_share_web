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
 * ⚠️ **経由地には2種類ある。**
 *    ・`through`（既定）… 楽しい道の中継点。**そこを通らせたいだけ**なので
 *      区間を分けない。break にすると「一度止まる」扱いで指示が増える。
 *    ・`break`（`stopAt` で指定）… 利用者が置いた立ち寄り先。
 *      **区間を分けないと「着きました」と言えない**（実機で報告: 立ち寄り先を
 *      設定したのに経路に出ず、通過しても何も起きなかった）。
 *    ・`break_through`（`throughStopAt` で指定）… おすすめ道路の終点。
 *      区間は分けるが、**その場で引き返させない**（`locationType` の説明を読むこと）。
 */
"use strict";

const { spokenRoadName, intersectionName, towardNames } = require("./navName");
const { shouldSayFollowTheRoad } = require("./navGuide");
const routeLoops = require("./routeLoops");
const trafficSignals = require("./trafficSignals");

/**
 * 曲がる地点から信号までの距離が、これ以内なら「信号のある交差点」とみなす。
 *
 * ⚠️ **実測で決めた**（2026-09-19・市街地と郊外の4経路・曲がる指示19件）:
 *    0〜10m に14件、次に近いのは81m、あとは100m超。あいだが空いているので、
 *    少し余裕を見て20m。⚠️ 信号は停止線に打たれ、向きごとに複数あることがある
 */
const SIGNAL_RADIUS_METERS = 20;
const { applicable: applicableRestrictions, hitsOnRoute, excludePolygonsFor }
  = require("./restrictionAvoid");
const { spansOnLine } = require("./restrictionOverlap");

const { encode } = require("./polyline");
const { applyRealisticTime } = require("./realisticTime");

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
  moped50:   { costing: "motor_scooter", canUseExpressway: false, topSpeed: 30, ferryWeight: 0.35 },
  // 法定60km/h・二段階右折なし。クルマの流れに乗れるので幹線寄り
  small125:  { costing: "motor_scooter", canUseExpressway: false, topSpeed: 60, ferryWeight: 0.45 },
  // ⚠️ **motorcycle は道路クラスのつまみが一切効かない**（下の注意書き参照）。
  //    既定で主要地方道65〜67%と、もともと幹線寄りに走る
  medium250: { costing: "motorcycle",    canUseExpressway: true },
  large:     { costing: "motorcycle",    canUseExpressway: true },
};

/**
 * **「フェリーを避ける」を外したときの `use_ferry`**（排気量ごと）。書いていなければ
 * Valhalla の既定（0.5＝好きでも嫌いでもない）。
 *
 * ⚠️ **原付を 0.5 にしないこと。** 原付は幹線を避ける重み（`ROAD_CLASS_TIERS`）で
 *    陸の費用が実時間の3倍ほどに膨らむので、重みの掛からない船を割安に見る。
 *    0.5 のままだと長距離フェリーを乗り継ぐ（実測 2026-09-23・50cc 新座→丸亀:
 *    東京九州フェリーで新門司へ行き、阪九フェリーで神戸へ戻る 船1,539km・43.8時間。
 *    宇野－高松の船なら 28.3時間）。
 * 実測（避けない・船の距離）:
 *              新座→丸亀  新座→今治  広島→松山  大阪→徳島  横須賀→館山
 *    50cc 0.5    1,539     1,642       64         56         12
 *    50cc 0.35      56         0       46         56         12   ← 採る
 *    125cc 0.5      77        77       46         56         12
 *    125cc 0.45     21         0       46         56         12   ← 採る
 *    125cc 0.4      21         0        0（199km走る）
 * ⚠️ 短い船（大阪→徳島・横須賀→館山・広島→松山）は使うこと。避けないと言った人に
 *    陸まわりを押しつけない。126cc以上は 0.5 のままで東京湾フェリーに乗る
 */
const FERRY_WEIGHT_WHEN_ALLOWED = 0.5;

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
/* ⚠️ **上限が0.3では足りなかった。** 実機で「高速を避けると国道140号まで
      捨てて細い道へ逃げる」と報告された。実測（新座→道の駅大滝温泉→広瀬ダム・
      大型・有料も回避）:
        0     140.4km 指示54 国道140号27.2km 名前なしの道16.7km
        0.15  138.5km 指示43 国道140号30.4km 名前なしの道15.6km
        0.3   139.1km 指示39 国道140号36.7km 名前なしの道 7.4km
        0.5   135.0km 指示20 国道140号51.1km 名前なしの道 0.3km  ← 高速は0kmのまま
      **0.5 は距離も曲がる数も少なく、国道が14.4km増える。** 高速は混ざらない。
   ⚠️ **上げても危なくない。** 段階は1つずつ試し、高速が混ざったら却下して
      下の段へ落ちる（`ridesExpressway`）。「高速が混ざらない一番ゆるい値」と
      いう性質は変わらない。呼び出しは最良の場合1回のままで、悪い場合だけ1回増える。
   ⚠️ **1.0 を足さないこと。** それは「避けない」と同じで、避ける意思が消える */
const HIGHWAY_LADDER = [0.5, 0.3, 0.15, 0];

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

// しまなみの6島の輪郭（`admin/tiles/shimanamiIslands.py` が作る）
const ISLAND_OUTLINES = require("./shimanamiIslands.json");

/**
 * **しまなみ海道を原付で渡らせるための経由地**（橋ごとに1点・橋の原付道の上）。
 *
 * 【なぜ要るか】125cc以下は本線（西瀬戸自動車道）を走れず、橋の原付道・
 * 自転車歩行者道を渡る。タイルを焼くときにその道を原付に開けてあるが
 * （`admin/tiles/patchShimanamiMoped.py`）、**それでも自由に引くとフェリーを選ぶ**。
 * 実測（2026-09-22・尾道→今治・125cc・しまなみだけ焼いたタイル）:
 *     自由に引く        73.8km  2.4時間  フェリー23.1km
 *     橋ごとに経由地     74.0km  1.8時間  陸路
 * 陸路のほうが Valhalla 自身の費用で8倍安い（11,549 対 93,989）のに、長い区間の
 * 探索では間の細い道を見つけきれない（`disable_hierarchy_pruning` も
 * 付け替え先を `secondary` にするのも効かなかった）。区間を短く切ると見つかる。
 *
 * ⚠️ **点は島ではなく橋に置く。** 島の真ん中に置くと、島の上が目的地のときに
 *    点まで寄り道する（実測: 尾道→大三島 44.6km → 55.3km）。かといって
 *    目的地の島の点を抜くと、その島で探しきれずに船へ回る（因島の土生→今治で
 *    金山－赤崎の船 522m が残った）。橋なら「渡る」ことだけを決められる。
 * ⚠️ **焼き直す前のタイルでは何も変わらない。** 橋の原付道が開いていないので、
 *    足すと「No path could be found」が返り、元の経路を使う（実測: :8002）
 * ⚠️ 点は**橋の原付道・自転車道の上**に置くこと（自転車の陸路が通る way の中点。
 *    `[経度, 緯度]`）。外すと本線など別の道に吸着する
 */
const SHIMANAMI = {
  // 経路がこの範囲で船に乗ったら、しまなみの話とみなす（島どうしの船など。
  // 本州と四国を結ぶ船は、この範囲の外でも見る。`shimanamiLocations` 参照）
  bounds: { minLon: 132.95, maxLon: 133.30, minLat: 34.05, maxLat: 34.42 },
  // 島の輪郭（端点がどの島の上にいるかを決めるためだけに使う。経由地にはしない）。
  // `admin/tiles/shimanamiIslands.py` が OSM の place=island から作る。
  // ⚠️ **島の上の1点からの近さで決めないこと。** 橋のそばの端点を隣の島と取り違え、
  //    手前の橋を往復する経路になって採れず、船が残った（実測 2026-09-23:
  //    因島の北端→今治で船 17.8km）。
  // ⚠️ **並びは尾道側→今治側で固定**（向島・因島・生口島・大三島・伯方島・大島）
  islands: ISLAND_OUTLINES.order.map((name) => ISLAND_OUTLINES.islands[name]),
  // 船でしか行けない近くの島と、その続きとみなす鎖の島（生名島→因島・岩城島→生口島など）。
  // ⚠️ 本州とみなすと尾道大橋から全部の橋を渡らせ、生名島→今治が 105km（船 7.9km）に
  //    なった。隣の因島へ渡れば 60km 弱で済む
  nearbyIslands: ISLAND_OUTLINES.others,
  // 橋（経由地にする）。`bridges[j]` は `islands[j - 1]` と `islands[j]` の間を渡す
  //    （j = 0 は本州→向島、j = 6 は大島→四国）。
  // ⚠️ **点は橋の長さの真ん中（海の上）に置くこと。** way の中央の「節点」にしたら
  //    多々羅大橋で陸から5m、生口橋で56mしか離れず、橋の下をくぐる国道317号を
  //    「橋を渡った」と数えた（`bridgePasses` が往復と取り違える）。
  //    下はどれも way の長さの半分の点。（　）は陸までの距離
  bridges: [
    [133.21659, 34.40933],   // 尾道大橋（way 90964667・ふつうの道・64m）
    [133.18036, 34.35723],   // 因島大橋（way 137112576・原付道・358m）
    [133.15007, 34.30375],   // 生口橋（way 297562264・176m）
    [133.06341, 34.25943],   // 多々羅大橋（way 123283517・586m）
    [133.05634, 34.21566],   // 大三島橋（way 90810156・原付道・87m）
    [133.07238, 34.19210],   // 伯方・大島大橋の大島大橋（way 391883761・原付道・271m）
    [133.00002, 34.12124],   // 来島海峡第二大橋（way 1520681838・1,432m）
  ],
  // 島の輪郭の外でも、これ以内なら島の上とみなす（桟橋や海沿いの店を指したとき。
  // 輪郭は約60mの粗さで間引いてある）
  nearIslandMeters: 300,
  // ⚠️ **本州か四国かは、この大まかな輪郭で決める。** 近さで決めると
  //    広島（本州）は今治のほうが近く、高松・徳島（四国）は尾道のほうが近い
  //    ので、逆の入口から入って島を往復する。
  //    ⚠️ 島の輪郭を先に見るので、ここは粗くてよい
  shikoku: [
    [132.00, 33.30], [132.70, 33.95], [132.92, 34.16], [133.00, 34.09],
    [133.10, 34.05], [133.50, 34.05], [133.60, 34.28], [133.85, 34.36],
    [134.15, 34.42], [134.45, 34.30], [134.62, 34.20], [134.80, 33.85],
    [134.25, 33.15], [133.50, 33.35], [133.00, 32.65], [132.45, 32.85],
    [132.30, 33.40],
  ],
  // 端点のすぐそばの橋は足さない。⚠️ 同じ場所に点が2つ並ぶと Valhalla が
  //    `leg_shape_index not set` で落ちる（`MIN_VIA_GAP_METERS` と同じ値・同じ理由）
  nearPointMeters: 25,
  // ⚠️ **遠回りでは弾かない。** 船に乗る経路は近道なので、陸で渡ると伸びて当然
  //    （実測: 広島→今治 87.6km → 160.3km・1.83倍、高松→尾道 109.1km → 217.4km・
  //    1.99倍。どちらも Valhalla 自身の費用では半分以下）。船を避けるのはこのアプリの
  //    方針で、東京湾フェリーでも2.5倍の陸まわりを採っている。
  //    これは**どんな理由でも採らない上限**（歯止め）で、狙いの値ではない。
  //    入口の取り違えで島を往復する経路は、下の `bridgePasses` で直接弾く
  maxStretch: 3,
  // 橋の点からこれ以内を通ったら「その橋を渡った」とみなす。
  // ⚠️ **いちばん陸に近い橋の点（尾道大橋・64m）より小さくすること。** 大きいと
  //    岸の道を「渡った」と数える。橋の上の経路は点をほぼ0mで通る
  bridgePassMeters: 40,
};

/** 平面に近似した座標（m）。⚠️ 並びや向きを決めるだけなので、この粗さで足りる */
function toMeters(p, lat0) {
  return [p[0] * 111_320 * Math.cos((lat0 * Math.PI) / 180), p[1] * 111_320];
}

/** 2点のおおよその距離（m） */
function approxMeters(a, b) {
  const [ax, ay] = toMeters(a, a[1]);
  const [bx, by] = toMeters(b, a[1]);
  return Math.hypot(bx - ax, by - ay);
}

/** 点が多角形の中にあるか（`[経度, 緯度]` の輪） */
function insideRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1])
        && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点から輪の縁までのおおよその距離（m） */
function metersToRing(p, ring) {
  const [px, py] = toMeters(p, p[1]);
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = toMeters(ring[i], p[1]);
    const [bx, by] = toMeters(ring[i + 1], p[1]);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + u * dx), py - (ay + u * dy)));
  }
  return best;
}

/**
 * 端点が**鎖のどこにいるか**。-1 = 本州、0〜5 = 島（`islands` の番号）、6 = 四国。
 *
 * ⚠️ 見る順: 島の輪郭の中 → 船で渡る近くの島の中（隣の鎖の島とみなす）→ 四国の中 →
 *    島の輪郭のすぐそば → それ以外は本州。
 *    鎖から離れた島（大崎上島など）は本州とみなす。足して取り違えても、
 *    往復する経路は `bridgePasses` で弾かれ、元の経路に戻るだけ
 */
function chainEntry(p) {
  const islands = SHIMANAMI.islands;
  const inside = islands.findIndex((ring) => insideRing(p, ring));
  if (inside >= 0) return inside;
  const nearby = SHIMANAMI.nearbyIslands.find((o) => insideRing(p, o.ring));
  if (nearby) return nearby.near;
  if (insideRing(p, SHIMANAMI.shikoku)) return islands.length;
  let best = -1, bestMeters = Infinity;
  islands.forEach((ring, i) => {
    const meters = metersToRing(p, ring);
    if (meters < bestMeters) { best = i; bestMeters = meters; }
  });
  return bestMeters <= SHIMANAMI.nearIslandMeters ? best : -1;
}

/**
 * 経路が**それぞれの橋を何回渡ったか**（`SHIMANAMI.bridges` の並び）。
 *
 * ⚠️ **2回渡っていたら、島を往復している。** 経由地は橋ごとに1回ずつ通らせる
 *    ので、ふつうは1回か0回。2回は、端点がどの島の上かを取り違えて、
 *    反対側の橋まで行ってから戻ってきた合図
 * - `points` は経路の点（`[経度, 緯度]`）
 */
function bridgePasses(points) {
  return SHIMANAMI.bridges.map((bridge) => {
    let passes = 0;
    let near = false;
    for (const p of points || []) {
      const d = approxMeters(p, bridge);
      // ⚠️ 近づいたときに1回と数え、十分離れるまで数え直さない（点が密でも1回）
      if (!near && d <= SHIMANAMI.bridgePassMeters) { passes++; near = true; }
      else if (near && d > SHIMANAMI.bridgePassMeters * 5) near = false;
    }
    return passes;
  });
}

/**
 * 船が**しまなみの船か、本州と四国を結ぶ船**なら、橋ごとの経由地を差し込んだ並びを返す。
 * 当てはまる船が無ければ null。
 *
 * - `locations` は Valhalla に渡す並び（`{lat, lon, type?}`）
 * - `ferries` は船ごとの `{mid, start, end}`（まんなか・乗る所・降りる所。`[経度, 緯度]`）
 *
 * ⚠️ **本州と四国を結ぶ船も見ること。** 遠くから四国へ行く経路は、しまなみから
 *    離れた船に乗る（実測: 新座→今治・京都→松山は宇野－直島－高松の船）。
 *    しまなみの範囲だけで見ると、いちばん直したい長い経路に効かない
 * ⚠️ **差し込むのは、船がいた区間（隣り合う2点の間）だけ。** 立ち寄り先の
 *    並びを崩さない。
 * ⚠️ **`through` で入れること。** `break` にすると島ごとに「着きました」と言う。
 *    `through` は区間(leg)を分けないので、アプリ側の区間の数も変わらない
 * ⚠️ 足した並びにもう一度かけても増えない。橋の点は区間の端に来るので、
 *    端点のすぐそば（`nearPointMeters`）として外れる
 */
function shimanamiLocations(locations, ferries) {
  const b = SHIMANAMI.bounds;
  if (!Array.isArray(locations) || locations.length < 2 || !Array.isArray(ferries)) return null;
  const しまなみの船 = (p) => p[0] >= b.minLon && p[0] <= b.maxLon && p[1] >= b.minLat && p[1] <= b.maxLat;
  const 四国へ渡る船 = (f) => insideRing(f.start, SHIMANAMI.shikoku) !== insideRing(f.end, SHIMANAMI.shikoku);

  // 船がいたのは、どの2点の間か（線分までいちばん近い組）
  const 区間 = new Set();
  for (const f of ferries) {
    if (!f || !f.mid || !(しまなみの船(f.mid) || 四国へ渡る船(f))) continue;
    const m = f.mid;
    let k = 0, best = Infinity;
    for (let i = 0; i < locations.length - 1; i++) {
      const a = [locations[i].lon, locations[i].lat], c = [locations[i + 1].lon, locations[i + 1].lat];
      const [px, py] = toMeters(m, m[1]), [ax, ay] = toMeters(a, m[1]), [cx, cy] = toMeters(c, m[1]);
      const dx = cx - ax, dy = cy - ay, len2 = dx * dx + dy * dy;
      const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d < best) { best = d; k = i; }
    }
    区間.add(k);
  }
  if (!区間.size) return null;

  const out = [];
  let added = false;
  for (let i = 0; i < locations.length; i++) {
    out.push(locations[i]);
    if (!区間.has(i)) continue;
    const a = [locations[i].lon, locations[i].lat];
    const b2 = [locations[i + 1].lon, locations[i + 1].lat];
    const from = chainEntry(a);
    const to = chainEntry(b2);
    // ⚠️ **間の橋を順に全部。** 1本でも抜くと、そこで船に回る。
    //    `bridges[j]` は j-1 と j の間なので、from → to で渡るのは
    //    from+1 〜 to（逆向きなら from 〜 to+1 を逆順）
    const 橋 = [];
    if (from < to) for (let j = from + 1; j <= to; j++) 橋.push(j);
    else for (let j = from; j > to; j--) 橋.push(j);
    for (const j of 橋) {
      const p = SHIMANAMI.bridges[j];
      if (approxMeters(p, a) <= SHIMANAMI.nearPointMeters
          || approxMeters(p, b2) <= SHIMANAMI.nearPointMeters) continue;
      out.push({ lat: p[1], lon: p[0], type: "through" });
      added = true;
    }
  }
  return added ? out : null;
}

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

/**
 * 辺ごとの速度と制限速度。**焼き直しの前後を比べるための道具。**
 *
 * ⚠️ **本番の応答には載せないこと。** `/trace_attributes` を1回余計に叩くので、
 *    経路を引くたびに呼ぶと通信が増える。計測と検査だけで使う。
 *
 * ⚠️ **`speed` と `speed_limit` は別物。**
 *      `speed`       … 経路計算に使う速度。maxspeed が無ければ Valhalla の既定
 *      `speed_limit` … OSM の maxspeed。**未登録なら0**。既定速度を焼き直しても動かない
 *    だから「`speed_limit === 0` の距離の割合」を前後で比べれば、
 *    **タグを壊していないこと**が確かめられる。
 *
 * ⚠️ 隣り合う辺をまとめないこと。way ごとに名指しで確かめたいので、辺のまま返す。
 *
 * @returns {Array<{wayId:number, roadClass:string, meters:number,
 *                  speed:number, speedLimit:number}>|null}
 */
async function speedSpans(shape, costing, baseUrl) {
  // ⚠️ **線の渡し方が2通りある。** `routeWithValhalla` が返す `polyline` は**5桁**、
  //    Valhalla 内部の `leg.shape` は**6桁**。混ぜると座標が10倍ずれるので、
  //    点の配列（`points`: [lng, lat]）を渡せるようにしておく
  const asPoints = Array.isArray(shape);
  const ask = async (shapeMatch) => {
    const res = await fetch(`${baseUrl || BASE}/trace_attributes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(asPoints
          ? { shape: shape.map(([lng, lat]) => ({ lat, lon: lng })) }
          : { encoded_polyline: shape }),
        costing,
        shape_match: shapeMatch,
        filters: {
          attributes: ["edge.way_id", "edge.road_class", "edge.length",
                       "edge.speed", "edge.speed_limit"],
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
    return json.edges.map((e) => ({
      wayId: e.way_id,
      roadClass: e.road_class,
      meters: Math.round((e.length || 0) * 1000),
      speed: e.speed || 0,
      // ⚠️ 未登録は0で返る。null にしないこと（呼ぶ側が `!speedLimit` で見ている）
      speedLimit: e.speed_limit || 0,
    }));
  } catch (e) {
    return null;
  }
}

/**
 * 区間(leg)ごとに測って、**全体の番号へ直して**繋ぐ。
 *
 * ⚠️ **`trip.legs[0].shape` だけで測らないこと。** `/trace_attributes` は線1本ぶんしか
 *    測れないのに、指示の `beginIndex` は全区間を通した番号。立ち寄り先(`break`)を
 *    置くと区間が割れるので、先頭以外が丸ごと落ちる。
 *    実測（青梅→道の駅大滝温泉→広瀬ダム・原付二種）: 通るだけなら雁坂トンネル
 *    6,811mを拾えるのに、大滝を立ち寄り先にすると **0m**。有料の知らせも
 *    指示ごとの内訳も出ず、県も先頭区間より後ろが全部 null になっていた
 *    （実機で報告: 有料を避ける設定なのに何も出ない）。
 * ⚠️ **区間の数だけ `/trace_attributes` を呼ぶ。** 呼ぶかどうかは呼び元で絞ること。
 */
async function spansOverLegs(trip, legMaps, fn) {
  const out = [];
  for (let i = 0; i < (trip.legs || []).length; i++) {
    const spans = await fn(trip.legs[i].shape);
    const at = legMaps[i] || [];
    // ⚠️ trace は最後の辺に「点の数」を返すことがある。表から溢れたら末尾に寄せる。
    //    ⚠️ **用心の条件。** 変異させても落ちない（この道では溢れない）
    const last = at.length ? at[at.length - 1] : 0;
    const map = (n) => (at[n] !== undefined ? at[n] : last);
    for (const sp of spans || []) out.push({ ...sp, begin: map(sp.begin), end: map(sp.end) });
  }
  return out;
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
          // ⚠️ **車線数もここで一緒に取る。** 別に `/trace_attributes` を
          //    叩くと1往復増える（この口は経路1本につき既に呼んでいる）
          attributes: ["edge.road_class", "edge.length", "edge.toll", "edge.lane_count",
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
      // ⚠️ **有料は区間(edge)から数えること。** 指示(maneuver)の旗は、一部でも
      //    有料を含むと丸ごう立つ。実測: 実際6.8kmの雁坂トンネルが28.4km（4倍）
      const toll = e.toll === true;
      // ⚠️ **車線数は OSM 由来で、入っていない道もある**（実測: 123辺中すべてに
      //    値はあったが、1車線は既定値のことがある）。2車線以上だけを当てにする
      const lanes = Number.isInteger(e.lane_count) ? e.lane_count : null;
      const last = spans[spans.length - 1];
      if (last && last.roadClass === e.road_class && last.toll === toll
          && last.laneCount === lanes) {
        last.end = e.end_shape_index;
        last.meters += Math.round((e.length || 0) * 1000);
      } else {
        spans.push({ roadClass: e.road_class, toll, laneCount: lanes,
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
//: 経路の線を1本につなぐ（区間をまたいで平らにする）。⚠️ 番号は使わない
const pointsOfTrip = (t) => (t.legs || []).flatMap((leg) => decode6(leg.shape));

const ferryMetersOf = (t) => (t.legs || []).reduce((a, leg) =>
    a + (leg.maneuvers || []).filter((m) => m.type === FERRY_MANEUVER)
      .reduce((b, m) => b + (m.length || 0) * 1000, 0), 0);

/**
 * 代替（Valhalla の `alternates`）のうち、**本命より船に長く乗らないもの**だけを残す。
 * ⚠️ 本命も船に乗るとき（北海道など避けられない航路）は、同じ長さまでは残す
 */
function alternatesNoMoreFerry(mainTrip, alternates) {
  const limit = ferryMetersOf(mainTrip || {});
  return (alternates || []).filter((a) => a && a.trip && ferryMetersOf(a.trip) <= limit);
}

/**
 * 引けた経路（`trip`）をアプリ・画面が読める形に組み立てる。
 *
 * ⚠️ **ここは引き直しをしない。** 引き直し（船・高速・有料・規制・無駄な輪・
 *    左側に到着）は `routeWithValhalla` の仕事で、その結果が `trip`。
 *    分けてあるのは、**代替ルートにも同じ組み立てをかける**ため。
 * ⚠️ 診断の数（何回引き直したか等）は本命のもの。代替には空を渡す
 */
/**
 * 避けきれなかった規制について、**アプリへ返す線の番号**で「どこを走るか」を数え直す。
 *
 * ⚠️ **避けるときに使った番号をそのまま返さないこと。** あれは `pointsOfTrip`
 *    （区間をただ繋いだもの）の番号で、`buildResult` が作る線とは点数が違う
 *    （継ぎ目の重複点を落とすため）。画面はこの番号で線を塗り分けるので、
 *    ずれると別の場所が赤くなるか、範囲外として捨てられる。
 */
function withSpansOn(built, rules) {
  if (!built || !Array.isArray(built.restrictionHits) || !built.restrictionHits.length) return;
  if (!Array.isArray(rules) || !rules.length) return;
  const byId = new Map(rules.map((r) => [r.id, r]));
  built.restrictionHits = built.restrictionHits.map((h) => {
    const rule = byId.get(h.id);
    if (!rule || !rule.points) return h;
    return { ...h, spans: spansOnLine(built.points, rule.points) };
  });
}

async function buildResult(trip, opts, costing, variantOptions, 診断) {
  const points = [];
  const steps = [];
  // ⚠️ **区間ごとの番号の対応表を残すこと。** `/trace_attributes` は線1本ぶんしか
  //    測れないので、測った結果を全体の番号へ直すのに要る（`spansOverLegs`）
  const legMaps = [];
  for (const leg of trip.legs) {
    // ⚠️ 区間ごとに shape が別々。区間をまたぐ番号として使えないので、
    //    いまの points の長さを足してから記録する
    // ⚠️ **区間の切れ目を覚えること。** ここで平らに繋ぐと立ち寄り先が消え、
    //    アプリが「経由地に着いた」と言えなくなる（実機で報告: 立ち寄り先を
    //    設定したのに経路に出ず、通過しても何も起きなかった）
    const stepsBeforeLeg = steps.length;
    const shape = decode6(leg.shape);
    // ⚠️ **足す前の長さを番号の起点にしないこと。**
    //    区間の先頭の点は前の区間の終点と同じで、下の重複除きで**足されない**。
    //    起点を points.length にしていたため2区間目以降が丸ごと1つずれ、
    //    最後の2指示がアプリで範囲外になって**黙って捨てられていた**
    //    （`ValhallaRouteService.parseStep` は `end < full.count` でないと nil）。
    //    実測（新座→ドンキ→オギノパン）: 点1868に対し最大の番号1868。
    //    捨てられた中に1,618mの走る指示があり、**最後の1.6kmが無案内**だった。
    //    番号の対応表を作れば、区間の中に重なった点があっても狂わない
    const at = [];
    for (const p of shape) {
      const tail = points[points.length - 1];
      if (!tail || tail[0] !== p[0] || tail[1] !== p[1]) points.push(p);
      at.push(points.length - 1);
    }
    const indexOf = (i) => (at[i] !== undefined ? at[i] : points.length - 1);
    legMaps.push(at);
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
        // ⚠️ **標識の「〇〇方面」。** Valhalla は返していたのに、ここで捨てていた。
        //    英字も含めて渡し、どれを読むかはアプリが言語で決める（`navName.towardNames`）
        towardNames: towardNames(m),
        // ⚠️ **曲がりくねった道で「直進します」と言わないための印。**
        //    この指示のあいだに走る線の曲率で決める（250度/km以上）
        isCurvyAhead: shouldSayFollowTheRoad(
          shape.slice(m.begin_shape_index || 0, (m.end_shape_index || 0) + 1)),
        distanceMeters: Math.round((m.length || 0) * 1000),
        durationSeconds: Math.round(m.time || 0),
        beginIndex: indexOf(m.begin_shape_index || 0),
        endIndex: indexOf(m.end_shape_index || 0),
        // ⚠️ **道の種別は Valhalla が maneuver ごとに教えてくれる。**
        //    道路名から「自動車道」を探すような当て推量をしないこと
        //    （実測: highway 3区間65.9km / toll 7区間70.6km を正しく拾えた）
        roadKind: m.highway ? "expressway" : (m.toll ? "toll" : "surface"),
        // ⚠️ **曲がる場所に信号があるか**（案内を「この交差点で」に変えるため）。
        //    Valhalla は信号を持っていないので OSM から自前で見る
        //    （`admin/lib/trafficSignals.js`）。実測: 曲がる19件のうち
        //    信号のある交差点は 0〜10m に14件、次に近いのは81m。20mで分かれる
        atSignal: trafficSignals.isNear(points[indexOf(m.begin_shape_index || 0)],
                                        SIGNAL_RADIUS_METERS),
      });
    }
    // ⚠️ **この区間の最後の指示が「着いた」にあたる。** Valhalla は区間ごとに
    //    到着の maneuver を返すので、その1つに印を付ける
    // ⚠️ `stepsBeforeLeg` との比較が効くのは「指示が1つも無い区間」のときだけ
    //    （そのときは前の区間の印を付け直さない）。答えは変わらないので、
    //    テストでは落ちない——**用心のための条件**と分かるように残す
    if (steps.length > stepsBeforeLeg) steps[steps.length - 1].isLegEnd = true;

  }

  // ⚠️ **読み上げに要る**（「県道36号線」の「県道」）。切るときは
  //    `withAdmins: false` を渡すこと。実測30msなので既定では取る
  const admins = opts.withAdmins === false ? null
    : await spansOverLegs(trip, legMaps, (sh) => adminSpans(sh, costing, opts.baseUrl));
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

  // ⚠️ **所要時間を実際の走りに近づける。** Valhalla は maxspeed 未登録の道に
  //    90km/h などを当てるので、下道の指示に上限をかける。
  //    ⚠️ **ここでやること**（指示が出揃い、まだ合計を作る前）。
  //       合計は下で指示の総和から作り直すので、順番を入れ替えないこと
  const 時間補正 = applyRealisticTime(steps);

  let classSpans = opts.withRoadClass === false ? null
    : await spansOverLegs(trip, legMaps, (sh) => roadClassSpans(sh, costing, opts.baseUrl));
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

    // ⚠️ **車線数は指示ごとに持たせる。** アプリは「2車線以上のときだけ
    //    車線を言う」判断に使う（1車線の道で「左車線へ」と言わないため）。
    //    ⚠️ 見るのは**曲がったあとに走る道**なので、指示の始まりの地点で引く
    for (const st of steps) {
      const sp = classSpans.find((x) => st.beginIndex >= x.begin && st.beginIndex < x.end);
      st.laneCount = sp ? sp.laneCount : null;
    }
  }

  // ⚠️ **有料・高速が出てくるときだけ測る。** 配信では `withRoadClass: false` で
  //    種別の内訳を作らないので（通信を減らすため）、そのままだと0になる。
  //    かといって毎回測ると `/trace_attributes` が1回増える。
  //    下道だけの経路には要らないので、そこは呼ばない。
  // ⚠️ **`avoidTolls` で絞らないこと。** 避ける指定の有無に関わらず、
  //    線を塗り分けるのに要る（指示の旗は一部でも立つので当てにならない）
  let tollSpans = classSpans;
  if (!tollSpans && steps.some((x) => x.roadKind !== "surface")) {
    tollSpans = await spansOverLegs(trip, legMaps,
                                    (sh) => roadClassSpans(sh, costing, opts.baseUrl));
  }
  const tollMeters = (tollSpans || []).reduce((a, sp) => a + (sp.toll ? sp.meters : 0), 0);

  // ⚠️ **線を塗り分けるのに使う「本当の区間」。**
  //    指示の `highway` / `toll` の旗は**一部でも含めば丸ごと立つ**。
  //    実測（新座→道の駅大滝温泉→広瀬ダム・251cc）: 「140を直進です 27.2km」の
  //    中身は **motorway 9.2km ＋ trunk 17.9km**。旗のまま塗ると、普通の国道140号
  //    17.9km まで高速の色になる（実機で報告:「高速を避けているのに緑の線が出る」）。
  //    ⚠️ **指示は分割できない**（曲がり方が狂う）ので、線のほうを区間で塗る。
  const kindOfSpan = (sp) =>
    // ⚠️ 高速が先。有料の高速は「高速」と呼ぶ（指示の旗と同じ決め方に揃える）
    (sp.roadClass === "motorway" ? "expressway" : (sp.toll ? "toll" : "surface"));
  const kindSpans = [];
  for (const sp of tollSpans || []) {
    const kind = kindOfSpan(sp);
    const last = kindSpans[kindSpans.length - 1];
    if (last && last.kind === kind && last.end === sp.begin) {
      last.end = sp.end;
      last.meters += sp.meters;
    } else {
      kindSpans.push({ begin: sp.begin, end: sp.end, kind, meters: sp.meters });
    }
  }

  // ⚠️ **指示ごとに「そのうち何mが有料か」を添える。**
  //    指示の有料の旗は、一部でも有料を含むと丸ごう立つ。実測: 実際6.8kmの
  //    雁坂トンネルを含む28.4kmの指示が丸ごと「有料」になり、画面の「通る道」が
  //    4倍に見えていた。**指示は分割できない**（曲がり方が狂う）ので、内訳を添える。
  //    ⚠️ **番号の幅を距離の代わりに使わないこと。** 線の番号は距離に比例しない
  //       （トンネルは直線なので点が少ない。実測: 6,811mの雁坂トンネルが
  //        番号では17番ぶんしかなく、按分すると599mになった）。
  //       **区間が持っている距離（`meters`）を使い、重なった割合だけ取る。**
  if (tollSpans) {
    const 重なり = (st, 対象) => {
      let m = 0;
      for (const sp of 対象) {
        const 幅 = Math.max(1, sp.end - sp.begin);
        const from = Math.max(st.beginIndex, sp.begin);
        const to = Math.min(st.endIndex, sp.end);
        if (to > from) m += sp.meters * ((to - from) / 幅);
      }
      return Math.min(st.distanceMeters, Math.round(m));
    };
    const 有料 = kindSpans.filter((sp) => sp.kind === "toll");
    const 高速 = kindSpans.filter((sp) => sp.kind === "expressway");
    for (const st of steps) {
      if (st.beginIndex == null || st.endIndex == null) continue;
      st.tollMeters = 重なり(st, 有料);
      // ⚠️ 高速も同じ。旗のままだと国道17.9kmが高速に見える
      st.expresswayMeters = 重なり(st, 高速);
    }
  }

  return {
    variant: opts.variant || "normal",
    // ⚠️ **表示名は返さない。** 呼ぶ側が作る。ここで日本語を返すと、
    //    APIを外に出したときに日本語が混ざる（`variant` は鍵なので言語に依存しない）
    costing,
    //: 実際に効いた設定（画面で確かめられるように）
    costingOptions: variantOptions,
    // ⚠️ 何回引き直したか。画面で「国道を通すために緩めた」が見えるように
    highwayTries: 診断.highwayTries,
    // 船を外すために何回引き直したか／それでも残った船の距離（避けられない航路）
    ferryTries: 診断.ferryTries,
    ferryMeters: Math.round(ferryMetersOf(trip)),
    // しまなみを橋ごとの経由地で渡らせたか（原付だけ。`SHIMANAMI` 参照）
    shimanamiUsed: 診断.shimanamiUsed === true,
    // 規制を避けるために何回引き直したか／それでも残った規制
    restrictionTries: 診断.restrictionTries,
    // ⚠️ **残ったものは黙って捨てない。** 画面とアプリで警告に使う
    restrictionHits: 診断.restrictionHits,
    restrictionSkipped: 診断.restrictionSkipped,
    restrictionPrefectures: 診断.restrictionPrefectures,
    // 目的地のどちら側に着いたか（"left" / "right" / null）。
    // ⚠️ 指定しても null で返ることがある（上の注意書き参照）
    arrivedSide: ((trip.locations || [])[(trip.locations || []).length - 1] || {})
      .side_of_street || null,
    // 側の指定を試したか／遠回りが大きすぎて諦めたか
    sideTried: 診断.sideTried, sideGaveUp: 診断.sideGaveUp,
    displacement: opts.displacement || null,
    lengthMeters: Math.round(trip.summary.length * 1000),
    // ⚠️ **`trip.summary.time` をそのまま返さないこと。** 上で指示ごとに
    //    時間を直しているので、合計も総和から作らないと内訳と合わなくなる
    durationSeconds: steps.reduce((a, st) => a + (Number(st.durationSeconds) || 0), 0),
    //: 補正の中身（どれだけ伸ばしたか）。実機との突き合わせ用
    timeAdjust: { ...時間補正, rawSeconds: Math.round(trip.summary.time) },
    points,
    polyline: encode(points),     // 5桁。このツールの他の線と揃える
    steps,
    uTurns: steps.filter((s) => s.maneuver.startsWith("uturn")).length,
    //: 小道に入って戻ってくる形。見つけた数と、塞いで消せた数
    wastefulLoops: 診断.wastefulLoops,
    wastefulLoopsDropped: 診断.wastefulLoopsDropped,
    wastefulLoopSpans: 診断.wastefulLoopSpans,
    // ⚠️ 「ふつう」がほぼ高速だった、のような事故に気づけるよう内訳を返す
    //    （実測: バイクの「ふつう」は77.8km中65.9kmが高速だった）
    //: 道路クラスごとの区間（色分け用）。取れなければ null
    classSpans,
    //: **避けきれなかった有料の距離。** `use_tolls: 0` は重みであって禁止ではない
    //  ので、代替路が無ければ通る。通ったことを黙らせないために返す
    //  ⚠️ 区間(edge)から数える。指示の旗では4倍に膨れる（実測 6.8km → 28.4km）
    tollUnavoidableMeters: tollMeters,
    //: クラスごとの距離
    classMeters: (classSpans || []).reduce((acc, sp) => {
      acc[sp.roadClass] = (acc[sp.roadClass] || 0) + sp.meters;
      return acc;
    }, {}),
    //: 線を塗り分けるための本当の区間（`begin`/`end` は `points` の番号）
    kindSpans,
    // ⚠️ **区間から数えること。** 指示の旗から数えると、一部が高速なだけの
    //    27.2kmの指示が丸ごと高速に数えられる（実測: 本当は9.2km）
    kindMeters: kindSpans.length
      ? kindSpans.reduce((acc, sp) => {
        acc[sp.kind] += sp.meters;
        return acc;
      }, { expressway: 0, toll: 0, surface: 0 })
      : steps.reduce((acc, x) => {
        acc[x.roadKind] += x.distanceMeters;
        return acc;
      }, { expressway: 0, toll: 0, surface: 0 }),
  };
}

/**
 * 経由地の種別を決める。
 *
 * ⚠️ **`break_through` は「立ち寄るが、来た道へ引き返さない」。** おすすめ道路の
 *    終点に使う。`break` だと、その場で向きを変えて**来た道を戻る**経路になる
 *    （実機で報告。実測・山中湖小山線→伊東: 到着方位66°→出発方位246°で
 *    199m 引き返していた。`break_through` にすると 68°・24m、距離は 218.7→218.6km）。
 * ⚠️ **行き止まりでも使ってよい。** 引き返すしか無い場所では引き返す経路が返る
 *    （実測・石廊崎 +0.1km、扇沢 変化なし）。禁止ではなく「その場で回らない」だけ。
 * ⚠️ **スポットには使わないこと。** 寄り道して戻るのは自然な動きで、
 *    塞ぐと遠回りになる。呼ぶ側（アプリ）が道の終点だけを指定する
 */
function locationType(index, opts = {}) {
  if (!(opts.stopAt || []).includes(index)) return "through";
  return (opts.throughStopAt || []).includes(index) ? "break_through" : "break";
}

/**
 * 「通るだけ」の点を何点まで残して引き直すか。**多い順に試す**。
 *
 * ⚠️ 実測（実機で報告 2026-09-20・鶴岡村上線29.5km）: 経由地**5点は引けるのに
 *    6点で落ちる**。だから最初に5を試す。0は「端だけで引く」最後の手段。
 */
const VIA_THINNING_STEPS = [5, 3, 0];

/**
 * 「通るだけ」(`through`) の点を等間隔に間引く。
 *
 * ⚠️ **止まる場所（`break` / `break_through`）は必ず残すこと。** 立ち寄り先と
 *    おすすめ道路の終点を落とすと、**行き先そのものが変わる**。
 * ⚠️ **両端を優先して残す。** 道の入口と出口が消えると、その道に入らない経路になる。
 *
 * @param middle 出発地と目的地を除いた並び
 * @param limit  残す「通るだけ」の点の数。0なら全部落とす
 */
function thinThroughPoints(middle, limit) {
  const at = [];
  middle.forEach((p, i) => { if (p.type === "through") at.push(i); });
  if (at.length <= limit) return middle;
  const keep = new Set();
  if (limit === 1) keep.add(at[0]);
  else if (limit > 1) {
    const step = (at.length - 1) / (limit - 1);
    for (let i = 0; i < limit; i++) keep.add(at[Math.round(i * step)]);
  }
  return middle.filter((p, i) => p.type !== "through" || keep.has(i));
}

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
  // ⚠️ **利用者が「フェリーを避ける」を外したときだけ乗せる**（`avoidFerries: false`）。
  //    渡されなければ避ける（これまでどおり。古いアプリは渡してこない）
  const avoidFerries = opts.avoidFerries !== false;
  if (avoidFerries) {
    variantOptions.use_ferry = 0;
    variantOptions.use_rail_ferry = 0;
  } else {
    variantOptions.use_ferry = (bike && bike.ferryWeight) || FERRY_WEIGHT_WHEN_ALLOWED;
  }

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
  // ⚠️ **進入方向は経由地と一緒に運ぶこと。** 下で重なった点を間引くので、
  //    別々の配列にすると番号がずれて**別の経由地の向き**が付く
  const viaHeadings = [];
  const rawHeadings = Array.isArray(opts.viaHeadings) ? opts.viaHeadings : [];
  for (const [index, p] of (opts.vias || []).entries()) {
    const last = vias[vias.length - 1];
    if (last && metersBetween(last, p) < MIN_VIA_GAP_METERS) continue;
    vias.push(p);
    viaHeadings.push(rawHeadings[index]);
  }
  const destination = { lat: to[1], lon: to[0] };
  // ⚠️ **走っている向きを渡すと、その場で向きを変えさせなくなる。**
  //    渡さないと「水道道路を南西方向です」＝いきなり逆を向けと言われる。
  //    渡すと「北東方向です → 左 → 左」と、そのまま進んで小道で回り込む形になる
  //    （実測・新座で 1.80km → 2.48km。遠回り +0.68km でUターンが消えた）。
  // ⚠️ **許容角は広めに取ること。** 狭いと道の向きから外れて、
  //    かえって逆向きの経路が返る（実測: 水道道路で heading=350 は
  //    許容45度から外れて「南西方向です」に戻った）。
  // ⚠️ **範囲外を丸める必要は無い。** Valhalla が内部で正規化する
  //    （実測: 370 は 10 として効き、-10 は 350 として効いた）。
  //    危ないのは **`CLLocation.course` が不明のとき -1 になる**ほうで、
  //    それは渡す前にアプリで弾く（`NavigationController`）
  const start = { lat: from[1], lon: from[0] };
  if (Number.isFinite(opts.heading)) {
    start.heading = opts.heading;
    start.heading_tolerance = Number.isFinite(opts.headingTolerance)
      ? opts.headingTolerance : 45;
  }
  const locations = [
    start,
    // ⚠️ **止まる場所だけ break にする。** 全部 through だと区間が1つになり、
    //    立ち寄り先に着いても知らせられない。逆に全部 break にすると、
    //    楽しい道の中継点ごとに「着きました」と言うことになる
    ...vias.map((p, i) => {
      const at = {
        lat: p[1], lon: p[0],
        type: locationType(i, opts),
      };
      // ⚠️ **「その向きで入れ」と言うと、行って戻るのではなく回り込む。**
      //    おすすめ道路の入口に、道に沿った向きを渡すために使う。
      //    実測（新座→大野東松山線→赤城大沼）: 指定なし 164.1km/往復11.1km →
      //    指定あり 167.5km/往復6.1km。**距離+3.4kmで往復が45%減る**
      //    ⚠️ 許容角を変えても結果は同じだった（15〜90度で往復6.1kmのまま）
      const heading = viaHeadings[i];
      if (Number.isFinite(heading)) {
        at.heading = ((heading % 360) + 360) % 360;
        at.heading_tolerance = 45;
      }
      return at;
    }),
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
  // ⚠️ **別の道も一緒に頼む。** Google のように選ばせるため。
  //    ⚠️ **立ち寄り先があると返らない**（Valhalla の性質。実測で1本だけ）。
  //       頼んでも無駄なので、2点のときだけ付ける。
  //       ⚠️ **この条件を外しても検査は落ちない**——Valhalla 側が返さないので
  //          振る舞いが変わらない。要らない頼みを送らないための用心
  //    ⚠️ **塞ぎと併用できる**（実測: 塞いだ場所を3本とも通らず、
  //       本命との重なりは33%だった）。だから代替も規制回避を通っている。
  //    ⚠️ 引き直しのたびに一緒に返ってくるが、使うのは最後の1回ぶんだけ
  if (opts.alternates > 0 && locations.length === 2) {
    body.alternates = opts.alternates;
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

  /** 船ごとの、まんなか・乗る所・降りる所（`[経度, 緯度]`）。
   *  ⚠️ **最初の船だけを見ないこと。** 長い経路では、四国へ渡る船より手前で
   *  別の船に乗ることがある */
  const ferriesOf = (t) => {
    const out = [];
    for (const leg of t.legs || []) {
      if (!(leg.maneuvers || []).some((x) => x.type === FERRY_MANEUVER)) continue;
      const shape = decode6(leg.shape);
      for (const m of leg.maneuvers || []) {
        if (m.type !== FERRY_MANEUVER) continue;
        const b = m.begin_shape_index || 0, e = m.end_shape_index || 0;
        const mid = shape[Math.floor((b + e) / 2)];
        if (mid) out.push({ mid, start: shape[b] || mid, end: shape[e] || mid });
      }
    }
    return out;
  };

  let json;
  //: しまなみの橋ごとの経由地を足したか（検査と調べもの用）
  let shimanamiUsed = false;
  let highwayTries = 1;
  let ferryTries = 1;
  let sideTried = false;
  let sideGaveUp = false;
  //: 無駄な輪を何本見つけ、何本消せたか（画面には出さない。検査と調べもの用）
  let wastefulLoops = 0;
  let wastefulLoopsDropped = 0;
  //: 塞げずに残った無駄な輪の場所（線の番号）。アプリが原因の道を外すのに使う
  let wastefulLoopSpans = [];
  let restrictionTries = 0;
  let restrictionHits = [];
  let restrictionSkipped = [];
  /** 当てはまる規制。⚠️ **代替の照合にも要る**ので、避ける処理の外でも持つ */
  let restrictionRules = [];
  /** 規制を読んだ県。⚠️ 見落としが起きていないか確かめるために返す */
  let restrictionPrefectures = [];
  try {
    json = await ask();

    // ⚠️ **通り抜けの指定で引けなければ、諦めて引き直す。** 「引き返さない」を
    //    守れない場所（本当に回れない行き止まり）で、経路そのものを失わないため。
    //    ⚠️ 実測では石廊崎・扇沢とも引けたので、ここは滅多に通らない保険
    if ((!json || !json.trip) && (opts.throughStopAt || []).length) {
      body.locations = locations.map((at) => (at.type === "break_through"
        ? { ...at, type: "break" } : at));
      json = await ask();
    }

    // ⚠️ **中継点が多いと Valhalla が落ちることがある。**
    //    `leg_shape_index not set for intermediate location` が返る。
    //    ⚠️ **最初の1回で落ちるので受け皿が無く、そのまま画面に出ていた**
    //       （実機で報告 2026-09-20: おすすめ道路2本のプランが引けない）。
    //    実測（鶴岡村上線29.5km・中継9点）: 経由地**5点は引けるのに6点で落ちる**。
    //    ⚠️ **重なりではない**（いちばん近い隣どうしで514.8m。`MIN_VIA_GAP_METERS`
    //       の話とは別物）。各点は単独なら通るし、同じ作り方でも
    //       大江西川線14.8kmは中継8点で引ける。道ごとの形の問題。
    //    ⚠️ **間引くのは「通るだけ」の点だけ**（`thinThroughPoints` を読むこと）。
    //       減らすほど道から外れるので、引けたところで止める
    //    ⚠️ `thinVias: false` は**検査専用の口**。材料（落ちる並び）がまだ
    //       落ちることを確かめるために要る。本番では渡さないこと
    if ((!json || !json.trip) && opts.thinVias !== false) {
      const 頭 = body.locations[0];
      const 尾 = body.locations[body.locations.length - 1];
      const 中 = body.locations.slice(1, -1);
      for (const 上限 of VIA_THINNING_STEPS) {
        const 間引いた = thinThroughPoints(中, 上限);
        // 減らないなら頼むだけ無駄
        if (間引いた.length === 中.length) continue;
        body.locations = [頭, ...間引いた, 尾];
        json = await ask();
        if (json && json.trip) break;
      }
    }

    // ⚠️ **しまなみ海道を原付で渡らせる。** 四国へ渡る船に乗ったら、橋ごとの
    //    経由地を足して引き直す（`SHIMANAMI` の説明を読むこと）。
    //    ⚠️ **船を塞ぐより先に試すこと。** 塞いでも別の船に乗るだけで、
    //       長い経路では引き直しが3回ぶん無駄になる（実測: 新座→今治は
    //       宇野－直島－高松の船。しまなみの範囲の外なので、範囲だけで見ると
    //       ここに来ない）
    //    ⚠️ **原付（motor_scooter）だけ。** 126cc以上は本線を走れるので要らない
    //    ⚠️ **採るのは、船が減り・島を往復していないときだけ。** フェリーを避けない
    //       設定なら、さらに Valhalla の費用でも安いときだけ（下の `採る` を読むこと）。
    //       焼き直す前のタイル（橋の原付道が閉じている）では引けずに元の経路を使う
    //    ⚠️ `shimanami: false` は**検査専用の口**。足さないと船に乗ることを
    //       確かめるために要る。本番では渡さないこと
    if (json && json.trip && costing === "motor_scooter" && opts.shimanami !== false
        && ridesFerry(json.trip)) {
      const 橋つき = shimanamiLocations(body.locations, ferriesOf(json.trip));
      if (橋つき) {
        const 前 = body.locations;
        body.locations = 橋つき;
        ferryTries++;
        const land = await ask();
        const 前の = json.trip.summary || {};
        const 今の = (land && land.trip && land.trip.summary) || {};
        // ⚠️ **フェリーを避けるなら、費用では弾かない。** `use_ferry: 0` は重みで、
        //    20km 程度の船なら 225km の遠回りより安いと判断される（実測 2026-09-23:
        //    新座→丸亀で 陸路1,072km 費用388,833 対 船846km 費用358,350。費用で比べて
        //    船が残った）。下の船を塞ぐ処理と同じく「船が減れば採る」。
        // ⚠️ **避けないなら、Valhalla 自身の費用で安いときだけ採る。** 探しきれなかった
        //    分の補正だけにする（船に乗ってよいと言った人を遠回りさせない）
        // ⚠️ **同じ橋を2回渡る経路は採らない。** 島を往復している（`bridgePasses`）
        const 採る = land && land.trip
          && ferryMetersOf(land.trip) < ferryMetersOf(json.trip)
          && (avoidFerries || !(今の.cost > 前の.cost))
          && 今の.length <= 前の.length * SHIMANAMI.maxStretch
          && bridgePasses(pointsOfTrip(land.trip)).every((n) => n <= 1);
        if (採る) {
          json = land;
          shimanamiUsed = true;
        } else {
          body.locations = 前;
        }
      }
    }

    // ⚠️ **船に乗ってしまったら、その場所を塞いで引き直す。**
    //    `shortest` では `use_ferry` が効かないため（上の説明を読むこと）
    if (avoidFerries && json && json.trip && ridesFerry(json.trip)) {
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

    // ⚠️ **有料道路を「重み」ではなく「禁止」にする。**
    //    `use_tolls: 0` は重みなので、代替路が無ければ通る（実測: 道の駅大滝温泉→
    //    広瀬ダムは雁坂トンネル6.8kmを避けられない）。塞いで引き直すと避けられるが、
    //    **115.2km/174分 → 227.9km/351分（+112.7km・約3時間）**。
    //    ⚠️ **既定にしてはいけない。** 遠回りを承知の利用者が選んだときだけ通す。
    // ⚠️ **囲いは小さく少なく。** Valhalla は除外領域の合計周長10,000mを超えると
    //    経路ごと失敗する（実測: 130m四方10個で弾かれた）
    if (json && json.trip && opts.excludeTolls) {
      // ⚠️ **区間(leg)を全部見ること。** 立ち寄り先の先にある有料を塞ぎ忘れる
      // ⚠️ **本命だけを見ないこと。** `use_tolls: 0` は重みなので、本命は
      //    たまたま避けられていることがある。そのとき塞ぐ相手が0件になり、
      //    引き直しても**代替の有料が素通り**する（実機で報告 2026-09-20:
      //    「有料道路を避ける設定だが、入っている」。本命は有料0mなのに
      //    代替0が鬼怒バイパス131mを通っていた）。
      //    ⚠️ 塞ぎは `body` 全体に効くので、代替の有料を塞げば本命も代替も避ける。
      //    ⚠️ trace が代替のぶん増えるが、ここは塞ぐと決めたときしか通らない
      const trips = [json.trip,
                     ...(json.alternates || []).map((a) => a && a.trip).filter(Boolean)];
      const hits = [];
      for (const trip of trips) {
        for (const leg of trip.legs || []) {
          const spans = await roadClassSpans(leg.shape, costing, opts.baseUrl);
          const shape = decode6(leg.shape);
          for (const sp of (spans || []).filter((x) => x.toll)) {
            hits.push({ points: shape.slice(sp.begin, sp.end + 1) });
          }
        }
      }
      if (hits.length) {
        const { polygons } = excludePolygonsFor(hits, { bufferMeters: 60 });
        if (polygons.length) {
          const keep = body.exclude_polygons;
          body.exclude_polygons = [...(keep || []), ...polygons];
          const detoured = await ask();
          if (detoured && detoured.trip) {
            json = detoured;
            // ⚠️ **塞いだままにすること。** ここで `keep` に戻すと、あとに続く
            //    引き直し（規制・左側に到着）が**塞ぎ無しで**引き直してしまう。
            //    しかも「左側に到着」は「遠回りより2km以上長くなければ採る」ので、
            //    短いトンネル経由が必ず勝つ。
            //    実測（青梅→道の駅大滝温泉→広瀬ダム・原付二種）:
            //    206.6km/有料0m が **92.7km/有料6,811m** に戻っていた
            //    （実機で報告:「遠回りして避ける」が同じ道を返す）
          } else {
            // ⚠️ 引けなければ元のまま。有料を通ることは `tollUnavoidableMeters` で伝わる
            if (keep) body.exclude_polygons = keep; else delete body.exclude_polygons;
          }
        }
      }
    }

    // ⚠️ **無駄な輪（小道に入って、ぐるっと回って戻ってくる形）を消す。**
    //    実機で報告:「楽しい道を選ぶと小道に入って小さい輪を描いてUターン路になる」。
    //    ⚠️ **形だけでは峠のヘアピンと見分けられない**（`lib/routeLoops.js` の
    //       説明を読むこと）。**入口から出口へ直接引いてみて**、近道があるものだけ塞ぐ。
    //       実測: ヘアピンは直接引いても0.99〜1.00倍、無駄な輪は0.00倍
    //       （8,858mの輪に対し36m）。確かめは1本 7〜13ms。
    // ⚠️ **どの区間のせいかは探さない。** 実測で、無駄な輪の5本中4本は
    //    最後のおすすめ道路を過ぎた先にあり、区間を外しても消えない。
    if (json && json.trip && opts.dropWastefulLoops !== false) {
      // ⚠️ **塞いだら、引き直した結果をもう一度見ること。**
      //    1回で終わらせていたため、塞いだ先に**新しい輪ができて残っていた**
      //    （実測・野火止→オギノパン西まわり125.9km: 2本塞いだ後の経路に
      //     1,002m と 3,001m の輪が新たに出ていた。画面にもそこが写っていた）。
      //    ⚠️ **回数は区切ること。** 塞ぐたびに経路が変わるので、際限が無い。
      const 守る = routeLoops.viasToKeep(opts.vias, opts.stopAt);
      let 塞いだ = [];
      // ⚠️ **最後にもう一周、数えるだけの回を入れること。** 塞ぎ切って終わると、
      //    最後の引き直しでできた輪を誰も見ない。実測（野火止→オギノパン・
      //    北まわり）: 10本塞いだのに、仕上がりに2本残っていて場所も返らなかった
      for (let 回 = 0; 回 <= routeLoops.MAX_ROUNDS; 回++) {
        const 線 = pointsOfTrip(json.trip);
        // ⚠️ **経路の長さを渡すこと。** 上限を割合で決めている（周回の旅で
        //    経路まるごとを輪と見ないため）。固定5,000mだった頃は
        //    119.7kmの往復がまったく見えていなかった
        const 全長 = json.trip.summary.length * 1000;
        const 候補 = routeLoops.loopBands(線, 全長);
        const 無駄 = [];
        for (const loop of 候補) {
          // ⚠️ **守るのは「利用者が置いた立ち寄り先」だけ。**
          //    おすすめ道路の中継点は**守らない**。利用者の意図は
          //    「おすすめ道路は上りか下りのどちらか一度だけ通って、出口から
          //     そのまま進む」であって、同じ道の反対車線を戻るのは
          //    **立ち寄り先へ寄るときだけ許容**（実機で明言された）。
          //    ⚠️ 以前ここで中継点まで守っていたため、消すべき往復が
          //       **1本も報告されなくなっていた**（実測: 5候補すべて0本）。
          if (routeLoops.holdsVia(線, loop, 守る)) continue;
          const 中 = routeLoops.interiorOf(線, loop);
          if (!中) continue;
          // ⚠️ **形だけでは峠のヘアピンと見分けられない。** 入口から出口へ
          //    直接引いてみて、近道があるものだけ塞ぐ。実測: ヘアピンは
          //    0.99〜1.00倍、無駄な輪は0.00倍。確かめは1本 7〜13ms。
          //    ⚠️ **同じ乗り物・同じ条件で引くこと。** 通れない道を近道と数えない
          const 直 = await routeWithValhalla(線[loop.begin], 線[loop.end], {
            displacement: opts.displacement,
            avoidHighways: opts.avoidHighways, avoidTolls: opts.avoidTolls,
            withAdmins: false, withRoadClass: false,
            dropWastefulLoops: false,          // ⚠️ 自分を呼び直さない
            baseUrl: opts.baseUrl,
          });
          const m = 直 && !直.error
            ? 直.steps.reduce((a2, st) => a2 + st.distanceMeters, 0) : null;
          if (routeLoops.isWasteful(loop.meters, m)) 無駄.push({ loop, points: 中 });
        }
        if (!無駄.length) {
          // ⚠️ 残っていないなら知らせることも無い（1周目で0なら 0/0）
          wastefulLoopSpans = [];
          break;
        }
        // ⚠️ **周を重ねるごとに足すこと。** 最初の周だけ数えていたため、
        //    「見つけ4／消せ10」という辻褄の合わない数字になっていた
        wastefulLoops += 無駄.length;
        // ⚠️ **塞げなかったときのために、場所を控える。** 経由地（おすすめ道路の
        //    出入口）そのものが輪になっていると、塞いだら経由地へ行けなくなるので
        //    引き直しが棄却される。そのときは**その道を外す**しかなく、それは
        //    アプリ側の担当（`RouteCandidatesView.funRouteCulprits`）。
        //    ⚠️ 番号は**いまの線**のもの
        wastefulLoopSpans = 無駄.map(({ loop }) => ({
          begin: loop.begin, end: loop.end, meters: Math.round(loop.meters),
        }));
        // ⚠️ 最後の回は塞がない。場所を返して終わる（アプリが原因の道を外す）
        if (回 === routeLoops.MAX_ROUNDS) break;
        // ⚠️ 短い輪なので、塞ぐ四角は詰めて置くこと（既定の1,000mおきでは1個しか置けない）
        // ⚠️ **前の周で塞いだぶんも一緒に渡すこと。** 渡さないと、前に消した輪が戻る
        const 塞ぐ = 塞いだ.concat(無駄.map(({ points }) => ({ points })));
        // ⚠️ **塞ぐ四角の間隔は輪の大きさに合わせること。** 120m おき固定だと、
        //    119.7kmの輪に約1,000個の四角を置こうとして、合計周長の上限
        //    10,000m を即座に超え、**1つも置けずに終わる**。
        //    1つの輪あたり40個までに収まる間隔にする
        const 間隔 = Math.max(120, Math.round(
          Math.max(...塞ぐ.map((h) => h.points.length)) * 10 / 40) * 10);
        const { polygons } = excludePolygonsFor(塞ぐ, { bufferMeters: 25, everyMeters: 間隔 });
        if (!polygons.length) break;
        const keep = body.exclude_polygons;
        const 戻す = () => {
          if (keep) body.exclude_polygons = keep; else delete body.exclude_polygons;
        };
        body.exclude_polygons = [...(keep || []), ...polygons];
        const redrawn = await ask();
        // ⚠️ **長くなったら採らない。** 塞いだせいで大回りになっては本末転倒
        if (redrawn && redrawn.trip
            && redrawn.trip.summary.length <= json.trip.summary.length * 1.05) {
          json = redrawn;
          wastefulLoopsDropped += 無駄.length;
          塞いだ = 塞ぐ;
          wastefulLoopSpans = [];
        } else {
          // 引けない／遠回りになる。**塞ぐ前に戻して、場所だけ知らせる**
          戻す();
          if (塞いだ.length) {
            body.exclude_polygons = [...(keep || []),
              ...excludePolygonsFor(塞いだ, { bufferMeters: 25, everyMeters: 120 }).polygons];
          }
          break;
        }
      }
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
      restrictionRules = rules;
      if (rules.length) {
        const handPolygons = body.exclude_polygons || [];
        const boxes = [];
        // ⚠️ **`verified` を落とさないこと。** 落とすと未確認（JARTIC の候補）を
        //    避けたのか、人が地図で見て登録したものを避けたのかが見る側に伝わらない
        //    （実際に落としていて、未確認がすべて「確認済」に見えていた）
        // ⚠️ **どこを走るかも渡すこと。** 画面はこの範囲を赤点線にして
        //    「ここは通れない」と示す（実機の要望）。件数だけでは場所が分からない
        const 申告形 = (hits) => hits.map((h) => ({
          id: h.id, name: h.name, ratio: h.ratio, verified: h.verified !== false,
          spans: h.spans || [], runMeters: h.runMeters }));
        // ⚠️ **申告は「返す経路」で数えたものであること。** 塞いでは引き直す
        //    ループは、上限まで試すと**最後に引き直した経路を測らないまま終わる**。
        //    そのまま返すと前の経路の件数を申告することになり、
        //    **通る規制を黙って通させる**ことになる。
        // ⚠️ **これは守りであって、直した不具合ではない。** 上限に達する経路4本
        //    （フルーツライン／湯袋観光道路／土浦高架道／桜川市・市道の各中点行き）で
        //    測ったが、**外しても結果は1件も変わらなかった**（id・範囲・走行距離まで同じ）。
        //    避けきれないから上限まで行くので、最後の引き直しでも同じ規制に当たる。
        //    ⚠️ 最後の1回で規制Aを避けきり、代わりに規制Bへ乗る形は作れていない。
        //       作れたらここを検査にすること（いまは変異で落とせないので検査は無い）
        let 測り済み = false;
        for (let i = 0; i < MAX_RESTRICTION_TRIES; i++) {
          const hits = hitsOnRoute(pointsOfTrip(json.trip), rules);
          測り済み = true;
          restrictionHits = 申告形(hits);
          if (!hits.length) break;
          const made = excludePolygonsFor(hits, {
            // ⚠️ 既に塞いでいるぶんを差し引く。合計で上限に当たる。
            //    ⚠️ `handPolygons` も数えること（船・**有料の塞ぎ**が入っている）
            maxPerimeterMeters: 10_000 - perimeterOfRings(boxes)
                                       - perimeterOfRings(handPolygons),
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
          測り済み = false;   // ⚠️ 引き直した経路はまだ測っていない
        }
        // ⚠️ 上限まで試して抜けたときだけここに落ちる。返す経路で数え直す
        if (!測り済み) restrictionHits = 申告形(hitsOnRoute(pointsOfTrip(json.trip), rules));
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

  const result = await buildResult(json.trip, opts, costing, variantOptions, {
    highwayTries, ferryTries, shimanamiUsed, restrictionTries, restrictionHits, restrictionSkipped,
    restrictionPrefectures, sideTried, sideGaveUp,
    wastefulLoops, wastefulLoopsDropped, wastefulLoopSpans,
  });
  // ⚠️ **範囲は「アプリへ返す線」で数え直すこと。** 避けるときに使った
  //    `pointsOfTrip` は区間をただ繋いだもので、**番号として使ってはいけない**
  //    （`buildResult` は区間の継ぎ目の重複点を落とすので点数が違う）。
  //    ずれたまま返すと、画面が**別の場所に赤い線を引く**か、
  //    範囲外として黙って捨てる（実機で報告 2026-09-20:
  //    同じ規制なのに候補によって赤い点線が出たり出なかったりした）
  withSpansOn(result, restrictionRules);
  // ⚠️ **代替も1本ずつ照合すること。** 「塞ぎは `body` に溜めてあるから代替も
  //    安全側になる」という前提で空にしていたが、**塞ぐと経路が引けないときは
  //    塞ぎを外して引き直す**ので、その前提が崩れる。実機で報告（2026-09-20):
  //    代替が規制を2件通っているのに「規制を避けた経路」と名乗っていた
  //    （朝日峠展望公園は表筑波スカイラインの沿道にあり、塞ぐと到達できない）。
  // ⚠️ **立ち寄り先があると代替は返らない**（Valhalla の性質。実測で1本だけ）
  // ⚠️ **フェリーを避けるなら、本命より船に長く乗る代替は返さない。** 船を塞ぐ処理は
  //    本命にしか効かないので、代替には船が素通りで残る。しかも船は近道なので
  //    「いちばん速くて短い」として先頭に出てしまう（実機で報告 2026-09-23:
  //    新座→霧島市。本命は船0kmなのに、代替が宇野－高松と四国→九州の船 88.7km）
  if (avoidFerries && Array.isArray(json.alternates)) {
    json.alternates = alternatesNoMoreFerry(json.trip, json.alternates);
  }
  if (Array.isArray(json.alternates) && json.alternates.length) {
    result.alternates = [];
    for (const a of json.alternates) {
      if (!a || !a.trip) continue;
      const altHits = restrictionRules.length
        ? hitsOnRoute(pointsOfTrip(a.trip), restrictionRules).map((h) => ({
            id: h.id, name: h.name, ratio: h.ratio, verified: h.verified !== false,
            spans: h.spans || [], runMeters: h.runMeters }))
        : [];
      const alt = await buildResult(a.trip, opts, costing, variantOptions, {
        highwayTries: 0, ferryTries: 0, restrictionTries: 0, restrictionHits: altHits,
        restrictionSkipped: [], restrictionPrefectures,
        sideTried: false, sideGaveUp: false,
        wastefulLoops: 0, wastefulLoopsDropped: 0, wastefulLoopSpans: [],
      });
      // ⚠️ 本命と同じく、返す線で数え直す
      withSpansOn(alt, restrictionRules);
      result.alternates.push(alt);
    }
  }
  return result;
}

module.exports = { routeWithValhalla, locationType, decode6, MANEUVER, VARIANTS, DISPLACEMENTS,
  thinThroughPoints, VIA_THINNING_STEPS,
  ROAD_CLASS_TIERS, ROAD_CLASS_COLORS, HIGHWAY_LADDER, MAX_SIDE_DETOUR_METERS,
  adminSpans,
  FERRY_EXCLUDE_DEGREES, FERRY_EXCLUDE_TRIES, FERRY_MANEUVER,
  SHIMANAMI, shimanamiLocations, chainEntry, bridgePasses, alternatesNoMoreFerry,
  roadClassSpans, speedSpans, SIGNAL_RADIUS_METERS, BASE };
