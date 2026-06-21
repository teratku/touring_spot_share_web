#!/usr/bin/env node
/**
 * savePrefectureRecommend.js
 * 各県のおすすめ（lib/prefectureRecommendSeed.js のスポット名）を
 * Nominatim でジオコーディングして data/prefecture-recommend/<romaji>.json に保存。
 * ビルダーで「おすすめ」パレットとして読込・対象追加に使う。
 *
 * 使い方: node savePrefectureRecommend.js
 *   - Firestore 認証は不要（Nominatim のみ）。ネットワーク必須。
 *   - 既存ファイルの手動追加(source:manual)はマージ保持。
 *   - Nominatim 規約のため 1.1秒/件のレート制限（全件で数分）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ROMAJI } = require("./lib/prefectures");
const SEED = require("./lib/prefectureRecommendSeed");

const OUT_DIR = path.join(__dirname, "data", "prefecture-recommend");
const UA = "biketeilen-rally-builder/1.0 (local admin tool)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queryOne(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1" +
    "&countrycodes=jp&accept-language=ja&q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!r.ok) return null;
  const d = await r.json();
  return Array.isArray(d) && d[0] ? d[0] : null;
}

// 「名前 県名」で検索→ヒットしなければ「名前」単独で再検索（取りこぼし回収）
async function geocode(name, pref) {
  let hit = await queryOne(`${name} ${pref}`);
  if (!hit) { await sleep(1100); hit = await queryOne(name); }
  if (!hit) return null;
  const a = hit.address || {};
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    address: [a.state || a.province, a.city || a.town || a.village || a.county].filter(Boolean).join(" ") || null,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prefs = Object.keys(SEED);
  let total = 0, ok = 0, fail = 0;
  for (const pref of prefs) {
    const romaji = ROMAJI[pref];
    if (!romaji) { console.warn("romaji未定義:", pref); continue; }
    const file = path.join(OUT_DIR, `${romaji}.json`);
    // 既存の手動分は保持
    let manual = [];
    if (fs.existsSync(file)) {
      try { manual = (JSON.parse(fs.readFileSync(file, "utf8")).spots || []).filter((s) => s.source === "manual"); } catch (_) {}
    }
    const seen = new Set(manual.map((s) => s.name));
    const curated = [];
    for (const name of SEED[pref]) {
      if (seen.has(name)) continue;
      let g = null;
      try { g = await geocode(name, pref); } catch (_) {}
      await sleep(1100);
      if (g && isFinite(g.lat) && isFinite(g.lng)) {
        curated.push({ name, lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6), address: g.address || pref, source: "curated" });
        seen.add(name); ok++;
      } else {
        fail++; console.warn(`  geocode失敗: ${pref} / ${name}`);
      }
    }
    const all = [...manual, ...curated];
    fs.writeFileSync(
      file,
      JSON.stringify({ prefecture: pref, romaji, count: all.length, curatedCount: curated.length, manualCount: manual.length, spots: all }, null, 2) + "\n"
    );
    total += all.length;
    console.log(`  ✅ ${pref}: ${curated.length}件（手動 ${manual.length}）`);
  }
  console.log(`\n完了: ${prefs.length}県 / 計 ${total} スポット / geocode 成功 ${ok}・失敗 ${fail}`);
  console.log(`→ ${path.relative(__dirname, OUT_DIR)}/`);
}
main().catch((e) => { console.error("❌", e.message); process.exit(1); });
