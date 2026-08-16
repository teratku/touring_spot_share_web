#!/usr/bin/env node
/**
 * fetchOsmRestrictions.js
 *
 * OpenStreetMap から二輪の通行規制を拾って、登録候補を作る。
 * 出力は admin/data/restriction-osm/<romaji>.json。
 *
 * 【なぜ要るか】
 * おすすめ道路（`buildRoadRecommend.js`）は OSM 由来だが、二輪が通れるかを見ていない。
 * そのため二輪通行禁止の道が「楽しい道」として配信されていた。実測：
 *   弥彦山スカイライン（新潟）83.3点 / 茨木能勢線（大阪）83.5点
 *   豊中亀岡線（大阪）81.2点 / 白山白川郷ホワイトロード（石川）70.9点
 * 規制を外す仕組みは入れたが、規制が**登録されていて初めて**働く。
 * 手で登録できているのは5県だけなので、残りをここで埋める。
 *
 * 【どこまで信じるか】
 * ⚠️ **そのまま配信しない。** ここで作るのは候補まで。
 *    区間の切れ目は OSM の都合で決まっていて、規制の実際の範囲とは限らない。
 *    road-builder の規制タブで地図を見て、1件ずつ登録すること。
 * ⚠️ OSM に付いていない規制は拾えない。手で登録する仕組みの置き換えではなく、
 *    手の届いていない県を埋めるもの。
 *
 * 使い方:
 *   node fetchOsmRestrictions.js --prefecture 石川県
 *   node fetchOsmRestrictions.js --all
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { ROMAJI } = require("./lib/prefectureRomaji");
const { TARGET_HIGHWAYS } = require("./lib/roadsAtPoint");
const { stitch } = require("./lib/roadStitcher");
const { polylineLength } = require("./lib/roadCsv");
const { simplify, encode } = require("./lib/polyline");
const { findOverlaps } = require("./lib/restrictionOverlap");
const { toCandidateFields } = require("./lib/osmRestrictionTags");

// ---- 引数 ----
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = argVal("--prefecture");
const ALL = args.includes("--all");

const ENDPOINT = "https://overpass-api.de/api/interpreter";
const OUT_DIR = path.join(__dirname, "data", "restriction-osm");
const UA = "biketeilen-admin/1.0 (local tool; tourigspotshare@gmail.com)";

/** 1県ごとに空ける時間。公開の Overpass に負担をかけない */
const POLITE_DELAY_MS = 4000;
/** 混んでいて断られたときの再試行の回数 */
const MAX_RETRY = 3;
/**
 * 断られたあと待つ時間。回を追うごとに 30秒 → 60秒 → 90秒。
 *
 * ⚠️ **短くしないこと。** 最初 8秒→16秒にしていたら、千葉県で 429 が
 *    2回続けて返った（実測）。Overpass は同時に使える枠が空くのを待つ作りなので、
 *    数秒の間隔では枠が空かない。急いでも取れない
 */
const RETRY_DELAY_MS = 30000;

/**
 * これより短い鎖は候補にしない。
 * ⚠️ 石川で 10m と 12m の孤立片が残った。落とさないと「12mの通行禁止」が候補に並ぶ。
 */
const MIN_CHAIN_METERS = 100;

/** 地図に出す線の粗さ。区間を確かめるだけなので粗くてよい（候補生成と揃えている） */
const TOLERANCE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1県ぶんの Overpass クエリ。
 *
 * ⚠️ **全国を bbox で引かないこと。** 日本を囲む矩形（24-46N, 122-146E）には
 *    韓国が丸ごと入り、実測で1,367件中1,065件が国外の道路だった。
 *    県の area で引けば混ざらない。
 *
 * ⚠️ **`highway` の絞りをここに書かないこと。** 書くと桁違いに遅くなる。
 *    石川県で実測: highway の正規表現あり **127.7秒** / 無し **8.4秒**（15倍）。
 *    全国47県では2時間と8分の差になる。歩道・自転車道はこちらで落とす
 *    （`toFragments`）。返る件数は60→145に増えるが、その程度は誤差。
 *
 * ⚠️ **`moped=no` を落とさないこと。** 原付だけ通れないバイパス・一般有料道路は
 *    二輪の指定が `motorcycle=designated`（むしろ通れる）になっていて、
 *    `motorcycle=no` では1本も引っ掛からない。神奈川県だけで324本ある
 *    （小田原厚木道路・横浜新道・ターンパイク箱根・芦ノ湖スカイラインなど）。
 */
function buildQuery(prefecture) {
  return `[out:json][timeout:120];
area["name"="${prefecture}"]["admin_level"="4"]->.a;
(
  way["motorcycle"="no"](area.a);
  way["motorcycle:conditional"](area.a);
  way["motor_vehicle"="no"](area.a);
  way["moped"="no"](area.a);
);
out geom;`;
}

/**
 * Overpass を叩く。混んでいるときは間隔を広げて再試行する。
 *
 * ⚠️ 504（混雑）は普通に返ってくる。実際に開発中に何度も踏んだ。
 *    1回で諦めると、その県だけ黙って candidates 0件になる。
 * @returns {object|null} 取れなければ null（**その県だけ諦めて次へ進む**）
 */
async function overpass(prefecture) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: buildQuery(prefecture) }),
      });
    } catch (e) {
      console.warn(`     ⚠️ ${prefecture}: 繋がらない（${e.message}）`);
      res = null;
    }
    if (res && res.ok) {
      try { return await res.json(); }
      catch (e) { console.warn(`     ⚠️ ${prefecture}: 応答を読めない（${e.message}）`); }
    } else if (res) {
      console.warn(`     ⚠️ ${prefecture}: ${res.status} で断られた（${attempt}/${MAX_RETRY}回目）`);
    }
    if (attempt < MAX_RETRY) {
      const wait = RETRY_DELAY_MS * attempt;
      console.warn(`     ⏳ ${Math.round(wait / 1000)}秒待って試し直す`);
      await sleep(wait);
    }
  }
  return null;
}

/**
 * Overpass の way を、道路断片（`roadStitcher` が食える形）にする。
 *
 * ⚠️ **歩道・自転車道はここで落とす。** 二輪規制タグが付く道の大半がこれ
 *    （全国822件のほとんど）。歩行者専用なのだから二輪が入れないのは当たり前で、
 *    規制として意味が無い。クエリ側で絞ると15倍遅くなるので、こちらで落とす。
 * ⚠️ **名前の無い way は落とす。** 全国131片あり、大半が高速のランプと住宅街の
 *    短い道（長さの中央値104m）。ツーリングのおすすめ道路にはまず出てこないので、
 *    残すと確かめるべき候補が埋もれる。
 */
function toFragments(elements, prefecture) {
  const fragments = [];
  for (const e of elements) {
    const tags = e.tags || {};
    if (!tags.name) continue;
    if (!TARGET_HIGHWAYS.has(tags.highway)) continue;
    if (!e.geometry || e.geometry.length < 2) continue;
    if (!toCandidateFields(tags).blocks) continue;
    fragments.push({
      prefecture, name: tags.name, ref: tags.ref || "", highway: tags.highway,
      osmId: String(e.id), tags,
      points: e.geometry.map((p) => [p.lon, p.lat]),
    });
  }
  return fragments;
}

/**
 * 鎖の規制内容をまとめる。
 *
 * ⚠️ 同じ道でも断片ごとにタグが違うことがある（一部だけ夜間規制など）。
 *    **いちばん強い規制（終日）に寄せず**、断片の多数派を採る。
 *    寄せると通れる区間まで禁止として配信することになる。
 *
 * ⚠️ **生のタグで揃っているかを見ないこと。** 意味が同じでも書き方は揺れる。
 *    ホワイトロードは55片のうち39片に `moped=no` が付き18片に付いていないが、
 *    読み替えた結果はどちらも同じ。生タグで比べると全部の道に
 *    「区間によって規制が違う」と注意書きが出て、本当に違う道が埋もれる。
 */
function dominantFields(members) {
  const counts = new Map();
  for (const m of members) {
    const fields = toCandidateFields(m.tags);
    // 読み替えた結果で比べる。`reason` は原文を含むので鍵から外す
    const { reason, sourceTag, ...meaning } = fields;
    const key = JSON.stringify(meaning);
    const hit = counts.get(key) || { count: 0, fields };
    hit.count++;
    counts.set(key, hit);
  }
  let best = null;
  for (const hit of counts.values()) if (!best || hit.count > best.count) best = hit;
  return { fields: best.fields, mixed: counts.size > 1 };
}

/** 登録済みの規制と重なる候補に印を付ける（二重登録を避ける） */
function alreadyRegistered(romaji, chains) {
  const file = path.join(__dirname, "data", "road-restrictions", `${romaji}.json`);
  if (!fs.existsSync(file)) return new Set();
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")).restrictions || []; }
  catch { return new Set(); }
  const { decode } = require("./lib/polyline");
  const restrictions = saved.map((r) => ({ id: r.id, name: r.name, kind: r.kind,
                                           points: decode(r.polyline) }))
                            .filter((r) => r.points.length >= 2);
  if (!restrictions.length) return new Set();
  const roads = chains.map((c, index) => ({ id: index, name: c.name, points: c.points }));
  return new Set(findOverlaps(restrictions, roads).keys());
}

/**
 * どの断片がこの鎖に入ったかを割り出す。
 *
 * ⚠️ `stitch` は本数しか返さない。名前で引き直すと、同じ名前で離れた場所にある
 *    別の鎖の断片まで混ざる（規制の種別も id も取り違える）。
 *    鎖は元の点をそのまま繋いだものなので、両端が鎖の上にあるかで見分けられる。
 */
function membersOf(chain, fragments) {
  const onChain = new Set(chain.points.map((p) => `${p[0]},${p[1]}`));
  const has = (p) => onChain.has(`${p[0]},${p[1]}`);
  return fragments.filter((f) => f.name === chain.name
                              && has(f.points[0]) && has(f.points[f.points.length - 1]));
}

/** 1県ぶんの候補を作る */
function buildCandidates(prefecture, romaji, elements) {
  const fragments = toFragments(elements, prefecture);
  if (!fragments.length) return [];

  const chains = stitch(fragments)
    .map((c) => ({ ...c, lengthMeters: Math.round(polylineLength(c.points)) }))
    // ⚠️ 短い切れ端を落とすのはここ。繋いだ**あと**でないと、
    //    元が細切れの道（石川は55片）を丸ごと捨ててしまう
    .filter((c) => c.lengthMeters >= MIN_CHAIN_METERS)
    .sort((a, b) => b.lengthMeters - a.lengthMeters);

  const dup = alreadyRegistered(romaji, chains);

  return chains.map((chain, index) => {
    const members = membersOf(chain, fragments);
    const { fields, mixed } = dominantFields(members);
    const simplified = simplify(chain.points, TOLERANCE);
    const polyline = encode(simplified);
    const reasons = [fields.reason];
    if (mixed) reasons.push("この道は区間によって規制の書かれ方が違う。範囲を必ず確かめること");
    if (dup.has(index)) reasons.push("登録済みの規制と重なっている（二重登録に注意）");

    return {
      // ⚠️ 取り込み直しても変わらない id にすること。変わると、登録済みの規制が
      //    候補と結び付かず「登録したのに消えた」ように見える。
      //    鎖の中でいちばん小さい OSM の way 番号なら、道が編集されない限り動かない
      id: `osm-${romaji}-${members.map((m) => Number(m.osmId)).sort((a, b) => a - b)[0]}`,
      prefecture, city: "",
      sourceRoad: chain.name,
      matchedName: chain.name,
      from: "", to: "",
      target: fields.sourceTag || "",
      targetLabel: fields.targetLabel,
      confidence: "OSM",
      reason: reasons.filter(Boolean).join(" / ") || null,
      // 道筋と区間の両方を同じ形で渡す。road-builder は道筋が無いとつまみを出せない
      chainPolyline: polyline,
      polyline,
      lengthMeters: chain.lengthMeters,
      geocode: null,
      kind: fields.kind,
      minCc: fields.minCc,
      maxCc: fields.maxCc,
      activeDays: fields.activeDays,
      includesHoliday: fields.includesHoliday,
      activeHours: fields.activeHours,
      fragmentCount: chain.fragmentCount,
      alreadyRegistered: dup.has(index),
    };
  });
}

// ---- 入口 ----

async function main() {
  const targets = ONLY ? [ONLY] : ALL ? Object.keys(ROMAJI) : null;
  if (!targets) {
    console.log("使い方:");
    console.log("  node fetchOsmRestrictions.js --prefecture 石川県   1県だけ取り込む");
    console.log("  node fetchOsmRestrictions.js --all                全国（数分かかる）");
    return;
  }
  const unknown = targets.filter((p) => !ROMAJI[p]);
  if (unknown.length) { console.error(`県名が分かりません: ${unknown.join("、")}`); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  const summary = [];
  let failed = 0;

  for (const prefecture of targets) {
    const romaji = ROMAJI[prefecture];
    const data = await overpass(prefecture);
    if (!data) {
      // ⚠️ 1県の失敗で全国を止めない。あとでその県だけ実行し直せる
      console.log(`  ❌ ${prefecture.padEnd(5)} 取れなかった（時間をおいて --prefecture で試すこと）`);
      failed++;
      await sleep(POLITE_DELAY_MS);
      continue;
    }
    const candidates = buildCandidates(prefecture, romaji, data.elements || []);
    if (candidates.length) {
      fs.writeFileSync(path.join(OUT_DIR, `${romaji}.json`), JSON.stringify({
        prefecture, romaji,
        builtAt: new Date().toISOString(),
        count: candidates.length,
        source: "openstreetmap",
        sourceUrl: "https://www.openstreetmap.org/",
        // ODbL なので出どころを明記する
        attribution: "© OpenStreetMap contributors（ODbL）",
        candidates,
      }, null, 1) + "\n");
      summary.push({ prefecture, count: candidates.length, longest: candidates[0] });
      console.log(`  ✅ ${prefecture.padEnd(5)} ${String(candidates.length).padStart(3)}本`
        + `　最長 ${candidates[0].sourceRoad}（${candidates[0].lengthMeters.toLocaleString()}m）`);
    } else {
      console.log(`  ・ ${prefecture.padEnd(5)}   0本`);
    }
    await sleep(POLITE_DELAY_MS);
  }

  console.log(`\n── まとめ ──`);
  console.log(`規制が見つかった県: ${summary.length} / ${targets.length}`);
  console.log(`候補の本数: ${summary.reduce((s, r) => s + r.count, 0)}`);
  if (failed) console.log(`⚠️ 取れなかった県: ${failed}（時間をおいて --prefecture で試すこと）`);
  console.log(`所要 ${((Date.now() - started) / 1000).toFixed(1)}秒`);
  console.log(`\n⚠️ これは候補です。road-builder の規制タブで地図を見て登録してください。`);
  console.log(`   http://127.0.0.1:4317/roads`);
}

module.exports = { buildQuery, buildCandidates, toFragments, MIN_CHAIN_METERS };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
