/**
 * admin/lib/mopedTurnRules.js
 *
 * **原付の右折方法の標識**（「二段階」「小回り」）を、JARTIC の交通規制情報から引く。
 *
 * 【なぜ要るか】
 * 原付の二段階右折は、法の既定（信号のある交差点・手前が片側3車線以上）を**標識で変えられる**
 * （道路交通法34条5項）。「小回り」の標識があれば3車線以上でも小回り、「二段階」の標識があれば
 * 2車線以下でも二段階。⚠️ **OSM には該当する項目が全国で0件**。JARTIC にはある
 * （共通規制種別コード 55=二段階・56=小回り）。
 *   実測（2026年07月分）: 小回りは各県51〜775件、二段階は茨城249・宮城110・兵庫5・東京2・岡山1ほか0。
 *   原付の経路で「二段階右折」と判定した全国16か所のうち5か所に小回りの標識があった（大阪駅前西など）。
 *
 * 【形が県ごとに違う】
 * ⚠️ 大阪・東京（と茨城の一部）は **3点の線**＝入る向き→交差点→右へ（どの向きから入る右折かが分かる）。
 *    愛知・兵庫・京都・宮城・岡山・群馬などは **点だけ**（向きが分からない）。茨城の2点の線（長さ15m前後）は
 *    道に沿っていることが多い（60件中45件）が、どちら向きか確かめられないので**点として扱う**。
 * ⚠️ 向きの分かる行は**向きまで合わせること。** 実測: 3m 先に、別の向きから入る右折の小回りの行があった（向き81°違い）。
 *
 * 形: `admin/data/jartic-moped-turns.json`（作り方は `admin/buildJarticMopedTurns.js`）。
 * ⚠️ 出典の表示が要る（JARTIC の利用規約。応答の `attribution` に入っている）
 */
"use strict";
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "jartic-moped-turns.json");
const METERS_PER_DEGREE = 111320;

/** 点だけの標識を、曲がる地点の標識とみなす距離（m）。
 *  実測（11都府県の原付の右折387か所）: 最寄りの点まで 0〜9m 10件・10〜19m 7件・20〜29m 7件・30〜39m 3件・40〜49m 1件。
 *  ⚠️ 広げると隣の交差点の標識を拾う（40〜55m 先の2件は隣の交差点の見込み） */
const POINT_RADIUS_METERS = 30;
/** 向きの分かる標識（3点の線の曲がり角）を、曲がる地点の標識とみなす距離（m）。
 *  ⚠️ 大きな交差点は曲がり角が離れる（大阪駅前西: 42m） */
const DIRECTED_RADIUS_METERS = 50;
/** 向きの分かる標識の、入る向きの許し幅（度）。実測: 合うものは2〜15°、別の向きは81°以上 */
const HEADING_TOLERANCE = 40;

/** JARTIC の共通規制種別コード → 種類 */
const KINDS = { "55": "twoStage", "56": "smallTurn" };

const toRad = (d) => (d * Math.PI) / 180;
function bearing(a, b) {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1]))
    - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const headingDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
function meters(a, b) {
  const dy = (b[1] - a[1]) * METERS_PER_DEGREE;
  const dx = (b[0] - a[0]) * METERS_PER_DEGREE * Math.cos(toRad(a[1]));
  return Math.hypot(dx, dy);
}

/**
 * JARTIC の「規制場所の経度緯度」（`経度 緯度;経度 緯度/…`）から、標識の場所を作る。
 *
 * - 3点で右へ曲がる形（+30〜+150°）→ 向きあり（曲がり角の点と入る向き）
 * - それ以外（点・2点・ほかの形）→ 向きなし（点ごと）
 * ⚠️ 壊れた値（`#VALUE!` など）は捨てる（実測で信号の行に1件あった）
 *
 * @returns {Array<{at:[number,number], inHeading:number|null}>}
 */
function placesFromGeometry(text) {
  const out = [];
  for (const seg of String(text || "").split("/")) {
    const pts = seg.split(";").map((p) => p.trim().split(/\s+/).map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (!pts.length) continue;
    if (pts.length === 3) {
      const inHeading = bearing(pts[0], pts[1]);
      const turn = ((bearing(pts[1], pts[2]) - inHeading + 540) % 360) - 180;
      if (turn >= 30 && turn <= 150) {
        out.push({ at: pts[1], inHeading: Math.round(inHeading) });
        continue;
      }
    }
    for (const p of pts) out.push({ at: p, inHeading: null });
  }
  return out;
}

/**
 * 曲がる地点の標識。無ければ null。
 *
 * ⚠️ **向きの分かる標識を先に見る**（点だけの標識より確か）。同じ確かさなら近いほう。
 *
 * @param {[number,number]} point 曲がる地点 [経度, 緯度]
 * @param {number|null} inHeading 入る向き（度）
 * @param {Array<{kind:string, at:[number,number], inHeading:number|null}>} rules 緯度順
 * @returns {{kind:"twoStage"|"smallTurn", meters:number, directed:boolean}|null}
 */
function ruleAt(point, inHeading, rules) {
  if (!Array.isArray(point) || !rules || !rules.length) return null;
  const dLat = DIRECTED_RADIUS_METERS / METERS_PER_DEGREE;
  let lo = 0, hi = rules.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rules[mid].at[1] < point[1] - dLat) lo = mid + 1; else hi = mid; }
  let directed = null, plain = null;
  for (let i = lo; i < rules.length && rules[i].at[1] <= point[1] + dLat; i++) {
    const r = rules[i];
    const m = meters(point, r.at);
    if (r.inHeading != null) {
      if (m <= DIRECTED_RADIUS_METERS && Number.isFinite(inHeading)
          && headingDiff(r.inHeading, inHeading) <= HEADING_TOLERANCE
          && (!directed || m < directed.meters)) directed = { kind: r.kind, meters: m, directed: true };
    } else if (m <= POINT_RADIUS_METERS && (!plain || m < plain.meters)) {
      plain = { kind: r.kind, meters: m, directed: false };
    }
  }
  return directed || plain;
}

let cached = null;
/** 読み込む（1回だけ）。無ければ空で動く（法の既定だけで決める） */
function load(file = FILE) {
  if (cached && cached.file === file) return cached.data;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.rules)) throw new Error("rules が無い");
  } catch (e) {
    console.error(`原付の右折方法の標識を読めません（法の既定だけで決めます）: ${e.message}`);
    data = { rules: [] };
  }
  cached = { file, data };
  return data;
}
function reset() { cached = null; }

module.exports = { placesFromGeometry, ruleAt, load, reset, bearing, KINDS, FILE,
  POINT_RADIUS_METERS, DIRECTED_RADIUS_METERS, HEADING_TOLERANCE };
