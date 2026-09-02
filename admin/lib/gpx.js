/**
 * gpx.js
 *
 * 経路を **Xcode / simctl で位置情報として流せる形**にする（純ロジック）。
 *
 * ⚠️ **書式の作り方をここ以外に置かないこと。** 端末（`makeGpx.js`）と
 *    画面（`server.js` の窓口）の両方から使う。2か所に持つと必ずずれる。
 *
 * 【Xcode の GPX の作法】
 * ⚠️ **`<wpt>` を並べる**（`<trkpt>` ではない）。Xcode の位置シミュレーションは
 *    waypoint の列を読み、点から点へ動かす。
 * ⚠️ **`<time>` を入れると、その時刻どおりの速さで動く。** 入れないと
 *    Xcode が一定間隔で進めるので、点が密だと実際よりずっと遅くなる。
 * ⚠️ 属性の名前は `lat` / `lon`。間違えると読まれない。
 *
 * 【simctl の作法】
 * ⚠️ **`simctl location start` は GPX を読まない。** `緯度,経度` の行を読む。
 *    点の間は自分で補間するので、点は粗くて足りる。
 */
"use strict";

const R = 6371000;
const rad = (x) => (x * Math.PI) / 180;

/** 2点の距離（m）。⚠️ 点は [経度, 緯度] */
function meters(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const la = rad(a[1]), lb = rad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 点の間隔をそろえる。
 * ⚠️ **元の点は間隔がまちまち**（曲がり角で密・直線で粗）。そのまま時刻を振ると
 *    速さが波打ち、曲がり角だけ極端に遅くなる。
 */
function resample(points, everyMeters) {
  if (!Array.isArray(points) || points.length < 2) return points || [];
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segment = meters(a, b);
    if (segment === 0) continue;
    let t = 0;
    while (carry + (segment - t) >= everyMeters) {
      t += everyMeters - carry;
      carry = 0;
      const f = t / segment;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    carry += segment - t;
  }
  const last = points[points.length - 1];
  if (meters(out[out.length - 1], last) > 1) out.push(last);
  return out;
}

/**
 * GPX にする（Xcode 用）。
 * @param {Array} points        [経度, 緯度] の配列
 * @param {object} opts         { speedKmh=40, everyMeters=20, name, startedAt }
 */
function toGpx(points, opts = {}) {
  const everyMeters = opts.everyMeters || 20;
  const speedKmh = opts.speedKmh || 40;
  const spaced = resample(points, everyMeters);
  const startedAt = opts.startedAt || Date.now();
  const perPoint = (everyMeters / (speedKmh * 1000 / 3600)) * 1000;   // ミリ秒
  const name = opts.name || `${speedKmh}km/h · ${spaced.length}点`;
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="biketeilen"
     xmlns="http://www.topografix.com/GPX/1/1">
  <!-- ⚠️ Xcode: Debug → Simulate Location → この名前を選ぶ -->
  <name>${String(name).replace(/[<&]/g, "")}</name>`;
  const body = spaced.map((p, i) => {
    const at = new Date(startedAt + i * perPoint).toISOString();
    return `  <wpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"><time>${at}</time></wpt>`;
  }).join("\n");
  return { text: `${head}\n${body}\n</gpx>\n`, count: spaced.length };
}

/**
 * simctl に渡す形にする。
 * ⚠️ **`緯度,経度` の順。** 経路データは [経度, 緯度] なので入れ替える
 */
function toSimctl(points, opts = {}) {
  const spaced = resample(points, opts.everyMeters || 100);
  return {
    text: spaced.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join("\n") + "\n",
    count: spaced.length,
  };
}

module.exports = { meters, resample, toGpx, toSimctl };
