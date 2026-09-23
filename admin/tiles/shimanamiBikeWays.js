#!/usr/bin/env node
/**
 * しまなみ海道で**自転車の陸路（尾道→今治）が使う道**を Valhalla から全部取り出し、
 * `shimanami-bike-ways.txt` に書く。`patchShimanamiMoped.py` がこの一覧の歩道系の道を
 * 原付に開ける。
 *
 * 【なぜ自転車の経路から取るか】
 * 原付が通れる道を OSM のタグから集めると途切れる（実測: 関係 2236106
 * 「しまなみ海道サイクリングロード」167本のうち39本が原付に閉じていて、
 * 関係に入っていない繋ぎの道も要る）。自転車は同じ橋を渡るので、
 * **自転車が実際に通った道**を取れば、繋がった一本の道として揃う。
 *
 * ⚠️ **付け替える前のタイルで引くこと。** 付け替えた後は cycleway が
 *    unclassified になっていて、自転車の経路そのものが変わる。
 *    OSM を更新したら、しまなみだけ切り出して焼いたタイルで引けば足りる
 *    （`osmium extract -b 132.90,34.03,133.30,34.45`・焼くのに2分ほど）。
 *
 * 使い方:
 *   node admin/tiles/shimanamiBikeWays.js [Valhalla のURL（既定 http://localhost:8002）]
 */
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:8002";
const OUT = path.join(__dirname, "shimanami-bike-ways.txt");
// 尾道駅の前と今治駅の前（しまなみの実測でずっと使ってきた2点）
const ONOMICHI = { lat: 34.4089, lon: 133.2050 };
const IMABARI = { lat: 34.0663, lon: 132.9977 };

async function post(endpoint, body) {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${endpoint}: ${json.error}`);
  return json;
}

(async () => {
  const route = await post("route", {
    locations: [ONOMICHI, IMABARI],
    costing: "bicycle",
    // ⚠️ 船に乗せない。乗ると、その区間の道が一覧から抜ける
    costing_options: { bicycle: { use_ferry: 0 } },
  });
  const trip = route.trip;
  if (trip.summary.has_ferry) {
    throw new Error("自転車の経路が船に乗った。一覧が途切れるので使えない");
  }
  const ids = new Set();
  for (const leg of trip.legs) {
    const attrs = await post("trace_attributes", {
      encoded_polyline: leg.shape,
      costing: "bicycle",
      shape_match: "edge_walk",
      filters: { attributes: ["edge.way_id"], action: "include" },
    });
    for (const e of attrs.edges || []) if (e.way_id) ids.add(String(e.way_id));
  }
  const sorted = [...ids].sort();
  fs.writeFileSync(OUT, sorted.join("\n") + "\n");
  console.log(`自転車の陸路（${trip.summary.length.toFixed(1)}km）が使う道 ${sorted.length}本 → ${OUT}`);
})().catch((e) => {
  console.error(`★ ${e.message}`);
  process.exit(1);
});
