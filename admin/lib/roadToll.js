"use strict";
/**
 * roadToll.js — おすすめ道路が有料道路を通るか（「有料」「一部有料」）。
 *
 * 利用者の要望（2026-10-11）:「web のおすすめ道路編集で各道に有料かどうかを記載して、アプリ側でも有料か表示。
 * ルート生成でもおすすめ道路が有料か無料で選択する基準を作る」
 *
 * 判定: OSM の `toll=yes` の道（`data/toll-ways.json`・`buildTollWays.js`）と線を重ねる。
 *  - 道の線の1区間ごとに、中点から `NEAR_METERS` 以内・向きの差 `ANGLE_DEG` 以内に有料の線があれば有料に数える
 *    （交差する道・並んで走る反対向きの別の道を数えないため。上下線はどちらの向きでも数える）
 *  - **高速（motorway/_link）の有料は、名前か路線番号が同じときだけ数える。** 一般道の真上を走る
 *    首都高・名古屋高速などを数えていた（高輪麻布線の 2.1km が首都高都心環状線）。
 *    ⚠️ 高速を一律に外さないこと。芦ノ湖スカイラインは OSM で一部が motorway になっていて、外すと落ちる
 *  - 割合が `FULL_RATIO` 以上 → "full"（有料）、有料の長さが `PARTIAL_METERS` 以上 → "partial"（一部有料）、ほかは無料
 *
 * ⚠️ 実測（2026-10-11・配信中の 6,522本・8/25 の OSM）: 有料 21本（伊豆スカイライン・芦ノ湖スカイライン・
 *    ターンパイク箱根・富士スバルラインなど）、一部有料 4本（嵐山高雄パークウェイ・国道135号（真鶴道路）・
 *    国道385号（三瀬）・国道112号（月山道路 1.05km））。500m 未満で無料にした7本は有料道路の入口に触れるだけ
 *    （熱海大仁線 0.2km など）。判定が外れたら調整ツールで人が直す（`roadOverrides` の `toll`）
 */
const fs = require("fs");
const path = require("path");
const { decode } = require("./polyline");

const DATA_FILE = path.join(__dirname, "..", "data", "toll-ways.json");
/** 有料の線を引き当てる格子（度）。0.003度 ≒ 330m */
const CELL = 0.003;
/** 有料の線とみなす近さ（m） */
const NEAR_METERS = 15;
/** 向きの差の上限（度）。交差する道を数えない */
const ANGLE_DEG = 30;
/** これ以上が有料なら「有料」 */
const FULL_RATIO = 0.8;
/** 有料の長さがこれ以上なら「一部有料」 */
const PARTIAL_METERS = 500;
const EXPRESS = new Set(["motorway", "motorway_link"]);
const R = 6371000;

/** 有料の道の一覧から、引き当て用の格子を作る。`ways` は `[{ n, r, h, p }]`（`buildTollWays.js` の形） */
function buildTollIndex(ways) {
  const grid = new Map();
  const list = [];
  for (const w of ways || []) {
    const pts = decode(w.p || "");
    if (pts.length < 2) continue;
    const id = list.length;
    list.push({ name: w.n || "", ref: w.r || "", highway: w.h || "" });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      // ⚠️ 長い1区間は何マスにもまたがる。両端のマスだけに入れると、真ん中で引き当てられない
      const la0 = Math.floor(Math.min(a[1], b[1]) / CELL), la1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      const ln0 = Math.floor(Math.min(a[0], b[0]) / CELL), ln1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      for (let la = la0; la <= la1; la++) {
        for (let ln = ln0; ln <= ln1; ln++) {
          const k = `${la}:${ln}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([a, b, id]);
        }
      }
    }
  }
  return { grid, ways: list };
}

/** `data/toll-ways.json` を読む。無ければ null（呼ぶ側が「判定しない」と知らせる） */
function loadTollIndex(file = DATA_FILE) {
  if (!fs.existsSync(file)) return null;
  return buildTollIndex(JSON.parse(fs.readFileSync(file, "utf8")).ways);
}

/** 名前か路線番号が同じか（高速の有料を数えてよいか） */
function sameRoad(road, toll) {
  const name = road.name || "", ref = road.ref || "";
  if (name && toll.name && (name.includes(toll.name) || toll.name.includes(name))) return true;
  return !!(ref && toll.ref && toll.ref.split(";").map((s) => s.trim()).includes(ref));
}

/**
 * 道の線のうち、有料の道に重なる長さ。
 * @param points [[経度, 緯度], ...]（`polyline.decode` の形）
 * @param road `{ name, ref }`（高速の有料を数えるかの判断に使う）
 * @returns `{ tollMeters, totalMeters, names }`。`names` は有料の道の名前（長い順・空の名前は除く）
 */
function measureToll(points, index, road = {}) {
  let total = 0, toll = 0;
  const byName = new Map();
  if (!index || !Array.isArray(points)) return { tollMeters: 0, totalMeters: 0, names: [] };
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    const lat0 = ((p[1] + q[1]) / 2) * Math.PI / 180;
    const kx = Math.cos(lat0) * R * Math.PI / 180, ky = R * Math.PI / 180;
    const px = p[0] * kx, py = p[1] * ky, qx = q[0] * kx, qy = q[1] * ky;
    const len = Math.hypot(qx - px, qy - py);
    total += len;
    if (len === 0) continue;
    const mx = (px + qx) / 2, my = (py + qy) / 2;
    const ang = Math.atan2(qy - py, qx - px);
    const cla = Math.floor(((p[1] + q[1]) / 2) / CELL), cln = Math.floor(((p[0] + q[0]) / 2) / CELL);
    let hit = null;
    for (let dla = -1; dla <= 1 && !hit; dla++) {
      for (let dln = -1; dln <= 1 && !hit; dln++) {
        for (const [a, b, id] of index.grid.get(`${cla + dla}:${cln + dln}`) || []) {
          const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / l2));
          if (Math.hypot(mx - (ax + t * dx), my - (ay + t * dy)) > NEAR_METERS) continue;
          let diff = Math.abs(((ang - Math.atan2(dy, dx) + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
          diff = Math.min(diff, Math.PI - diff);           // 上下線どちらの向きでも
          if (diff > (ANGLE_DEG * Math.PI) / 180) continue;
          const way = index.ways[id];
          if (EXPRESS.has(way.highway) && !sameRoad(road, way)) continue;
          hit = way;
          break;
        }
      }
    }
    if (hit) {
      toll += len;
      if (hit.name) byName.set(hit.name, (byName.get(hit.name) || 0) + len);
    }
  }
  return {
    tollMeters: Math.round(toll),
    totalMeters: Math.round(total),
    names: [...byName.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n),
  };
}

/** 測った長さから "full"（有料）・"partial"（一部有料）・null（無料） */
function tollKind({ tollMeters, totalMeters }) {
  if (!(totalMeters > 0) || !(tollMeters > 0)) return null;
  if (tollMeters / totalMeters >= FULL_RATIO) return "full";
  if (tollMeters >= PARTIAL_METERS) return "partial";
  return null;
}

/**
 * 区間に「有料」を付ける（`buildRoadRecommend.js` が調整を当てたあとに呼ぶ）。
 *
 * - 自動の判定（`measureToll`）に、調整ツールで人が決めた値（`tollSetting`。`applyOverrides` が写す）を上書きする。
 *   `"full"` / `"partial"` / `"none"`（無料と決めた）。
 * - 付けるのは有料のときだけ: `toll: "full"|"partial"`・`tollKm`（有料の長さ）。
 * - 人が決めたときは、自動の判定も残す（`tollAuto`・`tollAutoKm`。画面で「自動では○○」と出すため）。
 * ⚠️ `tollSetting` は配信しない（ここで消す）
 */
function applyToll(segments, index) {
  return segments.map((segment) => {
    const { tollSetting, ...rest } = segment;
    const measured = index ? measureToll(decode(rest.polyline || ""), index, rest) : null;
    const auto = measured ? tollKind(measured) : null;
    const autoKm = measured && measured.tollMeters > 0 ? Number((measured.tollMeters / 1000).toFixed(2)) : null;
    const kind = tollSetting === "none" ? null
      : tollSetting === "full" || tollSetting === "partial" ? tollSetting
      : auto;
    const out = { ...rest };
    if (kind) {
      out.toll = kind;
      // ⚠️ 人が「有料」にしたのに測れなかった（データに無い）ときは、道の長さを有料の長さにする
      const km = autoKm != null ? autoKm : kind === "full" ? rest.lengthKm : null;
      if (km != null) out.tollKm = km;
      if (measured && measured.names.length) out.tollNames = measured.names.slice(0, 3);
    }
    if (tollSetting) {
      out.tollAuto = auto || "none";
      if (autoKm != null) out.tollAutoKm = autoKm;
    }
    return out;
  });
}

module.exports = {
  buildTollIndex, loadTollIndex, measureToll, tollKind, applyToll, sameRoad,
  DATA_FILE, NEAR_METERS, ANGLE_DEG, FULL_RATIO, PARTIAL_METERS,
};
