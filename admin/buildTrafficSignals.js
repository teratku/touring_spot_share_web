/**
 * admin/buildTrafficSignals.js
 *
 * OSM の信号（`highway=traffic_signals`）を、配信に載る形（固定長の binary）へ変換する。
 *
 * ⚠️ **Valhalla は信号を教えてくれない**（`trace_attributes` の節点に項目が無い）。
 *    案内で「この交差点で」と言うには、自前で持つしかない。
 *
 * 作り方（手元で1回）:
 *   osmium tags-filter -o signals.osm.pbf japan.osm.pbf n/highway=traffic_signals
 *   osmium export signals.osm.pbf -f geojsonseq -o signals.geojsonseq
 *   node admin/buildTrafficSignals.js signals.geojsonseq admin/data/traffic-signals.bin
 *
 * 形: 緯度・経度を 1e6 倍した Int32 の組を、緯度の昇順で並べただけ（1点8バイト）。
 * ⚠️ **並びを崩さないこと。** 読む側は緯度で二分探索する
 */
"use strict";
const fs = require("fs");
const readline = require("readline");

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("使い方: node admin/buildTrafficSignals.js <signals.geojsonseq> <out.bin>");
    process.exit(1);
  }
  const points = [];
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let feature;
    try { feature = JSON.parse(line.replace(/^\x1e/, "")); } catch (e) { continue; }
    const c = feature && feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const [lng, lat] = c;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push([Math.round(lat * 1e6), Math.round(lng * 1e6)]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const buf = Buffer.alloc(points.length * 8);
  points.forEach(([lat, lng], i) => {
    buf.writeInt32LE(lat, i * 8);
    buf.writeInt32LE(lng, i * 8 + 4);
  });
  fs.writeFileSync(output, buf);
  console.log(`信号 ${points.length.toLocaleString()} 点 → ${output}（${(buf.length / 1024 / 1024).toFixed(2)}MB）`);
}
main();
