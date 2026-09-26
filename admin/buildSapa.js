/**
 * admin/buildSapa.js
 *
 * OSM の SA/PA の敷地（`highway=services` / `rest_area`）とガソリンスタンド（`amenity=fuel`）から、
 * 配信に載せる SA/PA の一覧 `admin/data/sapa.json` を作る（`admin/lib/sapa.js` が読む）。
 * 設計と実測は app repo `docs/sapa-plan.md`。
 *
 * 作り方（OSM を焼き直したら作り直す）:
 *   osmium tags-filter japan.osm.pbf nwr/highway=services,rest_area nwr/amenity=fuel -o sapa.osm.pbf
 *   osmium export sapa.osm.pbf -f geojsonseq -o sapa.geojsonseq
 *   node admin/buildSapa.js sapa.geojsonseq admin/data/sapa.json
 *
 * 形: { areas: [[緯度, 経度, "SA"|"PA", 名前, ガソリンスタンド(1/0), 敷地の輪郭[[経度, 緯度], ...]]] }
 * ⚠️ ガソリンスタンドの 0 は「不明」。OSM で SA の敷地の中にあるのは 902か所中192か所だけ（実際は多くの SA にある）
 */
"use strict";
const fs = require("fs");
const readline = require("readline");
const { simplify } = require("./lib/polyline");
const { isSapaName, kindOf, dropUmbrellas, fuelOf, ringArea } = require("./lib/sapa");

//: 輪郭を間引く幅（m）。寄れるかを試す点を選ぶのと、重なりを見るのに使うだけ
const SIMPLIFY_METERS = 5;

function outerRing(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return geometry.coordinates[0];
  if (geometry.type === "MultiPolygon") {
    // いちばん広い外周（敷地の本体）。⚠️ 頂点の数で選ばない（小さい離れ地の方が頂点が多いことがある）
    return geometry.coordinates.map((p) => p[0]).sort((a, b) => ringArea(b) - ringArea(a))[0];
  }
  return null;
}

function centerOf(ring) {
  const pts = ring.slice(0, -1).length ? ring.slice(0, -1) : ring;
  return [pts.reduce((a, p) => a + p[1], 0) / pts.length, pts.reduce((a, p) => a + p[0], 0) / pts.length];
}

/** geojsonseq の行（地物）から、SA/PA の敷地とガソリンスタンドを取り出す */
function collect(features) {
  const areas = [];
  const fuels = [];
  for (const f of features) {
    const p = (f && f.properties) || {};
    const g = f && f.geometry;
    if (!g) continue;
    if (p.amenity === "fuel") {
      if (g.type === "Point") fuels.push([g.coordinates[1], g.coordinates[0]]);
      else { const r = outerRing(g); if (r) fuels.push(centerOf(r)); }
      continue;
    }
    if (p.highway !== "services" && p.highway !== "rest_area") continue;
    if (!isSapaName(p.name)) continue;
    const ring = outerRing(g);
    if (ring) {
      const [lat, lon] = centerOf(ring);
      const thin = simplify(ring, SIMPLIFY_METERS).map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))]);
      areas.push({ lat, lon, name: p.name, kind: kindOf(p.name, p.highway), ring: thin });
    } else if (g.type === "Point") {
      areas.push({ lat: g.coordinates[1], lon: g.coordinates[0], name: p.name, kind: kindOf(p.name, p.highway), ring: [] });
    }
  }
  return { areas, fuels };
}

function build(features) {
  const { areas, fuels } = collect(features);
  const kept = dropUmbrellas(areas);
  return kept.map((a) => [Number(a.lat.toFixed(6)), Number(a.lon.toFixed(6)), a.kind, a.name,
                          fuelOf(a, fuels) === "yes" ? 1 : 0, a.ring])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("使い方: node admin/buildSapa.js <sapa.geojsonseq> <out.json>");
    process.exit(1);
  }
  const features = [];
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.replace(/^\x1e/, "").trim();
    if (!t) continue;
    try { features.push(JSON.parse(t)); } catch (e) { /* 壊れた行 */ }
  }
  const areas = build(features);
  const doc = {
    note: "高速の SA/PA。[緯度, 経度, SA|PA, 名前, ガソリンスタンド(1=あり/0=不明), 輪郭]。作り方は admin/buildSapa.js",
    areas,
  };
  fs.writeFileSync(output, JSON.stringify(doc) + "\n");
  const withFuel = areas.filter((a) => a[4]).length;
  console.log(`SA/PA ${areas.length} か所（ガソリンスタンドあり ${withFuel}）→ ${output}`
    + `（${(fs.statSync(output).size / 1024).toFixed(0)}KB）`);
}

if (require.main === module) main();

module.exports = { collect, build, outerRing, centerOf };
