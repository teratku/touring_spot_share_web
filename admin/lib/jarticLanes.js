/**
 * jarticLanes.js
 *
 * 曲がる手前の**進入路の車線数**を、JARTIC の交通規制情報から引く。
 *
 * 【なぜ要るか】
 * 車線の案内は手前の道の車線数で決まる（`NavLaneEstimate`・原付の二段階右折）が、OSM の lanes は
 * 道の途中の数で、右折レーンで増えた停止線の前の数ではない。
 * 実測（埼玉の経路・曲がる手前で JARTIC と比べられた40か所）: OSM と同じ3・違う37
 * （OSM に車線数なし→2が14、なし→3が6、2→3が12 など）。
 *
 * 【形】1つの進入路に行が2つある（どちらも停止線の手前35mほどの線）。
 *   進行方向別通行区分（58）・進行方向別通行区分及び進路変更禁止（119）… 矢印で車線が分かれている所
 *   車両通行帯（20）… 同じ所の片側の車線数（`車両通行帯数`）
 * 2つが重なる所だけ使う。
 *
 * ⚠️ **車線ごとの矢印は JARTIC に無い**（方向の列は埼玉の全行で空）。「右端は右折」とは言えるが、
 *    「左から2番目が直進」のような案内は作れない。
 * ⚠️ **線の向きを信じない。** 車両通行帯の線は停止線から離れる向きのこともある（三橋三丁目）。両端から見る。
 * ⚠️ 車両通行帯だけの線は使わない。対向車の出口側にも引かれていて、自分の進入路と見分けられない。
 *
 * 形: `admin/data/jartic-lanes.json`（作り方は `admin/buildJarticMopedTurns.js`）。
 * ⚠️ 出典の表示が要る（JARTIC の利用規約。応答の `attribution` に入っている）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { bearing } = require("./mopedTurnRules");
const { isAlwaysOn } = require("./jarticTurnBans");
const { linesOf } = require("./jarticOneways");

const FILE = path.join(__dirname, "..", "data", "jartic-lanes.json");
const METERS_PER_DEGREE = 111320;

/** 矢印で車線が分かれている規制の共通規制種別コード */
const DESIGNATED_KINDS = new Set(["58", "119"]);
/** 車両通行帯の共通規制種別コード */
const LANES_KIND = "20";
/** 2本の線を同じ進入路とみなす、両端の差（m）。実測: 三橋三丁目で3m */
const PAIR_METERS = 15;
/** 進入路の端を、曲がる地点の進入路とみなす距離（m）。大きな交差点は停止線と曲がる点が離れる */
const APPROACH_METERS = 45;
/** 入る向きの許し（度） */
const HEADING_TOLERANCE = 35;
/** 曲がる地点が線の端より手前でもよい長さ（m）。これを超えると次の交差点の進入路 */
const BEHIND_METERS = 5;
const CELL_DEGREES = 0.001;

const headingDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function meters(a, b) {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * METERS_PER_DEGREE * k, (b[1] - a[1]) * METERS_PER_DEGREE);
}

/**
 * CSV の1行を、進入路の材料へ。使わない行は null。
 * @returns {{a:[number,number], b:[number,number], lanes:number|null}|null} lanes が null なら矢印の行
 */
function laneRowFrom(row) {
  const code = String(row["共通規制種別コード"] || "").trim();
  if (!DESIGNATED_KINDS.has(code) && code !== LANES_KIND) return null;
  if (String(row["県別規制種別名称"] || "").includes("高速") || !isAlwaysOn(row)) return null;
  const lines = linesOf(row["規制場所の経度緯度"]);
  if (lines.length !== 1) return null;
  const line = lines[0];
  const shape = { a: line[0], b: line[line.length - 1] };
  if (code !== LANES_KIND) return { ...shape, lanes: null };
  const lanes = Number(String(row["車両通行帯数"] || "").trim());
  return Number.isInteger(lanes) && lanes >= 2 ? { ...shape, lanes } : null;
}

/**
 * 矢印の行と車両通行帯の行で、同じ所を指すものを組にする。
 * @returns {Array<{a:[number,number], b:[number,number], lanes:number}>}
 */
function pairApproaches(rows) {
  const cellOf = (p) => `${Math.round(p[0] / CELL_DEGREES)},${Math.round(p[1] / CELL_DEGREES)}`;
  const byCell = new Map();
  for (const r of rows) {
    if (r.lanes == null) continue;
    for (const p of [r.a, r.b]) {
      const key = cellOf(p);
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(r);
    }
  }
  const out = [];
  for (const d of rows) {
    if (d.lanes != null) continue;
    let best = null;
    const [cx, cy] = [Math.round(d.a[0] / CELL_DEGREES), Math.round(d.a[1] / CELL_DEGREES)];
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const r of byCell.get(`${x},${y}`) || []) {
          const gap = Math.min(Math.max(meters(d.a, r.a), meters(d.b, r.b)),
            Math.max(meters(d.a, r.b), meters(d.b, r.a)));
          if (gap <= PAIR_METERS && (!best || gap < best.gap)) best = { gap, lanes: r.lanes };
        }
      }
    }
    if (best) out.push({ a: d.a, b: d.b, lanes: best.lanes });
  }
  return out;
}

/** 線の両端を、そちらへ向かって走ったときの「停止線」として並べる（緯度順） */
function endsOf(approaches) {
  const ends = [];
  for (const { a, b, lanes } of approaches) {
    ends.push({ at: a, heading: bearing(b, a), lanes }, { at: b, heading: bearing(a, b), lanes });
  }
  return ends.sort((x, y) => x.at[1] - y.at[1]);
}

/**
 * 曲がる地点へ入ってくる進入路。
 * @param {[number,number]} point 曲がる地点 [経度, 緯度]
 * @param {number|null} inHeading 入る向き（度）
 * @returns {{lanes:number, meters:number}|null}
 */
function approachAt(point, inHeading, ends) {
  if (!Array.isArray(point) || !Number.isFinite(inHeading) || !ends || !ends.length) return null;
  const dLat = APPROACH_METERS / METERS_PER_DEGREE;
  let lo = 0, hi = ends.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid].at[1] < point[1] - dLat) lo = mid + 1; else hi = mid; }
  let best = null;
  for (let i = lo; i < ends.length && ends[i].at[1] <= point[1] + dLat; i++) {
    const e = ends[i];
    const m = meters(e.at, point);
    if (m > APPROACH_METERS || headingDiff(e.heading, inHeading) > HEADING_TOLERANCE) continue;
    // ⚠️ 曲がる地点が線の端の先にあること。手前なら、線はこの先の交差点の進入路
    const off = headingDiff(bearing(e.at, point), e.heading);
    if (m > BEHIND_METERS && off > 90) continue;
    if (!best || m < best.meters) best = { lanes: e.lanes, meters: m };
  }
  return best;
}

let cached = null;
/** 読み込む（1回だけ）。無ければ空で動く（OSM の車線数だけで決める） */
function load(file = FILE) {
  if (cached && cached.file === file) return cached.ends;
  let ends = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.approaches)) throw new Error("approaches が無い");
    ends = endsOf(data.approaches);
  } catch (e) {
    console.error(`進入路の車線数を読めません（OSM の車線数だけで決めます）: ${e.message}`);
  }
  cached = { file, ends };
  return ends;
}
function reset() { cached = null; }

module.exports = { laneRowFrom, pairApproaches, endsOf, approachAt, load, reset, FILE,
  APPROACH_METERS, PAIR_METERS };
