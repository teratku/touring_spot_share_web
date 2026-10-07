"use strict";

/**
 * おすすめ道路を配信するとき、本番に上がっている内容と同じかを確かめる。
 *
 * ⚠️ 利用者の要望（2026-10-07）:「おすすめ道路 調整ツールで配信するとき、現在アップしている内容と同じ場合は
 *    配信するか聞くようにする」。
 * ⚠️ 比べるのは中身の指紋（contentHash）。作り直した手元の data/road-recommend/<県>.json と、
 *    配信したときに本番の road_recommend/<県> に残した指紋。⚠️ どちらかに指紋が無いと分からない（null）
 * ⚠️ 本番は読むだけ
 */

const fs = require("fs");
const path = require("path");

/** 同じなら true、違えば false、分からなければ null */
function sameAsDeployed(local, deployed) {
  const a = local && local.contentHash;
  const b = deployed && deployed.contentHash;
  if (!a || !b) return null;
  return a === b;
}

/** 手元の作り直したデータと本番の記録を読んで比べる */
async function compareWithDeployed({ db, dataDir, romaji }) {
  let local = null;
  try { local = JSON.parse(fs.readFileSync(path.join(dataDir, `${romaji}.json`), "utf8")); } catch { /* まだ無い */ }
  const snapshot = await db.collection("road_recommend").doc(romaji).get();
  const deployed = snapshot.exists ? snapshot.data() : null;
  return {
    same: sameAsDeployed(local, deployed),
    localHash: (local && local.contentHash) || null,
    deployedHash: (deployed && deployed.contentHash) || null,
    deployedGeneration: deployed ? deployed.generation || null : null,
  };
}

/** 配信を止めて確かめるべきか（本番と同じで、まだ「それでも配信する」と言われていない） */
function needsConfirm({ commit, same, confirmSame }) {
  return commit === true && same === true && confirmSame !== true;
}

module.exports = { sameAsDeployed, compareWithDeployed, needsConfirm };
