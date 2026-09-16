"use strict";

/**
 * 所要時間を実際の走りに近づける。
 *
 * 【なぜ要るか】
 * Valhalla は maxspeed が登録されていない道に、**日本の実態とかけ離れた速度**を
 * 当てる。実測（利用者のツーリング 372km・関東〜山梨〜群馬）:
 *
 *   クラス     未登録率  未登録に当てる速度   同じクラスで登録済みの制限速度
 *   trunk        66%          90km/h                 47km/h
 *   primary      29%          74km/h                 41km/h
 *   secondary    68%          60km/h                 53km/h
 *
 * 国道の6割が未登録で「90km/h で走り続ける」計算になっていた。
 * 交差点などの上乗せもわずか4%しかない。
 *
 * 実走行との突き合わせ（出発・到着マーカーで切り出し）:
 *   アプリの予想   372.3km / 402分 / 平均55.5km/h
 *   実際に動いた   402.7km / 617分 / 平均**39.1km/h**
 *
 * 【なぜ上限をかける形にしたか】
 * クラス別に直すには `/trace_attributes` を区間の数だけ呼ぶ必要があるが、
 * 配信は `withRoadClass: false` で、下道だけの経路では**一度も呼んでいない**
 * （通信を減らすため）。実測で比べたところ、指示ごとに上限をかけるだけで
 * ほぼ同じ結果になった:
 *
 *   クラス別に直す（通信 +4回 +84ms）   698分 / 42.1km/h
 *   指示に上限45km/h（通信を増やさない） 708分 / 41.6km/h   ← こちら
 *
 * ⚠️ **高速・有料には上限をかけないこと。** そこは実際に速く走れる。
 *    実測: 東京→名古屋（高速あり）は上限をかけても +1分しか変わらない
 *    ＝ 下道の区間にしか効いていないことの確認になる。
 *
 * ⚠️ **都市部の渋滞はこの上限では直らない。** 新宿→横浜は元から43km/h で
 *    上限に届かないため素通りする。実際の都市部はもっと遅い。
 *    そこを直すには走行実績からの学習が要る（未対応）。
 *
 * ⚠️ **停車時間は含まない。** 上の実走行では撮影・食事で119分止まっている。
 *    ここが直すのは「走っている時間」だけ。
 */

/**
 * 下道で見込む上限速度（km/h）。
 *
 * ⚠️ **この値を上げると元の楽観的な時間に戻る。** 45 は実測で決めた値で、
 *    50 だと681分、55 だと664分（実走行ペースは752分）。
 * ⚠️ 日本の一般道の法定上限は60km/h。信号・右左折・先行車を込みにすると
 *    長い区間で45km/h を超え続けることはまず無い。
 */
const SURFACE_CAP_KMH = 45;

/** 上限をかけない種別。実際に速く走れるので触らない */
const FAST_KINDS = new Set(["expressway", "toll"]);

/**
 * 指示1つぶんの、実際に近づけた所要秒数。
 *
 * ⚠️ **短すぎる指示は触らない。** 距離が数十mの「左折します」は
 *    時間のほとんどが交差点の上乗せで、速度として読むと意味が無い。
 * ⚠️ 元より短くはしない（速くする方向の補正はしない）。
 */
function adjustedSeconds(step, capKmh = SURFACE_CAP_KMH) {
  const meters = Number(step && step.distanceMeters) || 0;
  const seconds = Number(step && step.durationSeconds) || 0;
  if (seconds <= 0 || meters <= 0) return seconds;
  if (FAST_KINDS.has(step.roadKind)) return seconds;
  // ⚠️ 100m 未満は速度として読まない（上の注意書き）
  if (meters < 100) return seconds;

  const kmh = (meters / 1000) / (seconds / 3600);
  if (!(kmh > capKmh)) return seconds;
  return Math.round((meters / 1000) / capKmh * 3600);
}

/**
 * 経路まるごとに補正をかける。**渡された配列と合計を書き換える。**
 *
 * ⚠️ **指示ごとの時間と合計をずらさないこと。** 画面は区間ごとの合計を
 *    足し上げて出すので、合計だけ直すと内訳と合わなくなる。
 *
 * @param {Array} steps  指示の配列（`durationSeconds` を書き換える）
 * @param {number} capKmh
 * @returns {{before:number, after:number, addedSeconds:number, touched:number}}
 */
function applyRealisticTime(steps, capKmh = SURFACE_CAP_KMH) {
  let before = 0, after = 0, touched = 0;
  for (const step of steps || []) {
    const was = Number(step.durationSeconds) || 0;
    const now = adjustedSeconds(step, capKmh);
    before += was;
    after += now;
    if (now !== was) {
      touched += 1;
      step.durationSeconds = now;
    }
  }
  return { before, after, addedSeconds: after - before, touched };
}

module.exports = {
  SURFACE_CAP_KMH, FAST_KINDS,
  adjustedSeconds, applyRealisticTime,
};
