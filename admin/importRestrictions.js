#!/usr/bin/env node
/**
 * importRestrictions.js
 *
 * 開発者が確認して登録した通行規制（data/road-restrictions/<romaji>.json）を
 * Firestore の road_restrictions/{romaji} へ投入する。
 *
 * おすすめ道路と違って件数が少ない（全国476件・1県あたり数十件）ので、
 * Storage は使わず Firestore の1ドキュメントに県ぶんをまとめる。
 *
 * 使い方:
 *   node importRestrictions.js --all                      # 検証のみ（既定・書き込まない）
 *   node importRestrictions.js --prefecture 茨城県 --commit
 *   node importRestrictions.js --all --commit
 *
 * ⚠️ 本番の Firestore に書き込みます。まず --commit 無しで確認してください。
 * ⚠️ 誤った区間を配信すると「通れない」と誤案内することになる。
 *    自動生成した候補をそのまま入れず、必ず画面で確認したものだけを登録すること。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { ROMAJI } = require("./lib/prefectureRomaji");
const { isSellable } = require("./lib/restrictionOrigin");

const PROJECT_ID = "biketeilen";
const COLLECTION = "road_restrictions";
const DATA_DIR = path.join(__dirname, "data", "road-restrictions");

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const ALL = args.includes("--all");
const ONLY = argVal("--prefecture");

/** ポリラインを解いて、まともな区間かを確かめる */
function decode(encoded) {
  const points = []; let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    for (const isLat of [true, false]) {
      let shift = 0, result = 0, b;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (isLat) lat += d; else lng += d;
    }
    points.push([lng / 1e5, lat / 1e5]);
  }
  return points;
}

function lengthMeters(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    m += Math.hypot((y1 - y2) * 111320, (x1 - x2) * 111320 * Math.cos((y1 * Math.PI) / 180));
  }
  return m;
}

/**
 * 配信してよいかを確かめる。
 * ⚠️ 短すぎる区間は自動生成の失敗（21m になった例がある）。落とさず止める。
 */
function validate(data) {
  const problems = [];
  /**
   * 配信APIから外れるもの。⚠️ **止めない**（`jmpsa` のように、表示だけで
   * 配信しないのが正しいものもある）。ただし**黙って上げない**。
   * 実機で報告（2026-09-20): 手で登録した規制の出どころが空で、一覧には出るのに
   * 経路が避けないまま気づけなかった。
   */
  const notSellable = [];
  for (const [i, r] of (data.restrictions || []).entries()) {
    const at = `restrictions[${i}]${r.name ? `（${r.name}）` : ""}`;
    if (!r.id || !r.name) { problems.push(`${at}: id / name が無い`); continue; }
    if (!r.polyline) { problems.push(`${at}: 区間が無い`); continue; }
    if (!r.checkedAt) { problems.push(`${at}: 確認日が無い`); continue; }
    let points;
    try { points = decode(r.polyline); } catch { problems.push(`${at}: 区間を解けない`); continue; }
    if (points.length < 2) { problems.push(`${at}: 区間の点が足りない`); continue; }
    const [lng, lat] = points[0];
    if (lat < 20 || lat > 46 || lng < 122 || lng > 154) {
      problems.push(`${at}: 区間が日本の外（${lat.toFixed(3)},${lng.toFixed(3)}）`);
      continue;
    }
    const meters = lengthMeters(points);
    if (meters < 50) problems.push(`${at}: 区間が短すぎる（${Math.round(meters)}m）自動生成の失敗を疑う`);
    if (meters > 100_000) problems.push(`${at}: 区間が長すぎる（${Math.round(meters / 1000)}km）`);
    if (r.minCc != null && r.maxCc != null && r.minCc > r.maxCc) {
      problems.push(`${at}: 排気量の下限が上限より大きい（${r.minCc}〜${r.maxCc}）`);
    }
    if (r.activeMonths && r.activeMonths.some((m) => m < 1 || m > 12)) {
      problems.push(`${at}: 月の指定がおかしい`);
    }
    // ⚠️ **経路が避けるのは、配信APIに載るものだけ**（`restrictionOrigin.js`）。
    //    出どころが無い・売れないものは、一覧に出ても**経路は通る**
    if (!isSellable(r)) {
      notSellable.push(`${r.name}（出どころ ${r.origin || "なし"}）`);
    }
    // ⚠️ 曜日・時間帯は配信データにそのまま載る（`restrictions` を丸ごと送っている）。
    //    おかしな値を通すと、アプリ側が「効いていない時間」を通行禁止と案内する
    if (r.activeDays && r.activeDays.some((d) => d < 1 || d > 7)) {
      problems.push(`${at}: 曜日の指定がおかしい（1=月〜7=日）`);
    }
    if (r.activeHours) {
      const hm = /^\d{1,2}:\d{2}$/;
      const { from, to } = r.activeHours;
      if (!hm.test(from || "") || !hm.test(to || "")) {
        problems.push(`${at}: 時間の書き方がおかしい（07:00 のように）`);
      } else if (from === to) {
        problems.push(`${at}: 時間の開始と終了が同じ（終日にするなら指定しない）`);
      }
    }
  }
  // ⚠️ 止めない。**知らせる**（`problems` とは別に返す）
  return Object.assign(problems, { notSellable });
}

async function main() {
  if (!ALL && !ONLY) { console.error("--all か --prefecture <県名> を指定してください"); process.exit(1); }
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`登録された規制がありません: ${DATA_DIR}\n  /roads の「通行規制」タブで登録してください`);
    process.exit(1);
  }

  const targets = [];
  for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
    const prefecture = Object.keys(ROMAJI).find((n) => ROMAJI[n] === data.romaji);
    if (ONLY && prefecture !== ONLY) continue;
    if (!(data.restrictions || []).length) continue;   // 空は配信しない
    targets.push({ file, data, prefecture });
  }
  if (!targets.length) { console.error("配信するものがありません（登録が0件）"); process.exit(1); }

  console.log(`${COMMIT ? "投入" : "検証（書き込みません）"}: ${targets.length}県\n`);

  let bad = 0;
  for (const t of targets) {
    const problems = validate(t.data);
    if (problems.length) {
      bad++;
      console.log(`  ❌ ${t.prefecture}`);
      for (const p of problems.slice(0, 5)) console.log(`      ${p}`);
    } else {
      const oldest = t.data.restrictions.map((r) => r.checkedAt).sort()[0];
      console.log(`  ✅ ${String(t.prefecture).padEnd(6)} ${String(t.data.restrictions.length).padStart(3)}件  最も古い確認日 ${oldest}`);
      // ⚠️ **配信に載らないものを黙って上げない。** 一覧には出るのに経路は通る、
      //    という食い違いに気づけないまま配信してしまう（実機で報告）
      const skipped = problems.notSellable || [];
      if (skipped.length) {
        console.log(`      ⚠️ ${skipped.length}件は配信APIに載りません（経路は避けません）:`);
        for (const nameAndOrigin of skipped.slice(0, 5)) {
          console.log(`         ${nameAndOrigin}`);
        }
        if (skipped.length > 5) console.log(`         ほか${skipped.length - 5}件`);
      }
    }
  }
  if (bad) { console.error(`\n${bad}県に問題があります。投入を中止しました`); process.exit(1); }
  if (!COMMIT) { console.log("\n書き込むには --commit を付けてください"); return; }

  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, "serviceAccount.json");
    admin.initializeApp({
      projectId: PROJECT_ID,
      credential: fs.existsSync(keyPath)
        ? admin.credential.cert(require(keyPath))
        : admin.credential.applicationDefault(),
    });
  }
  const db = admin.firestore();
  for (const t of targets) {
    await db.collection(COLLECTION).doc(t.data.romaji).set({
      prefecture: t.prefecture,
      romaji: t.data.romaji,
      count: t.data.restrictions.length,
      restrictions: t.data.restrictions,
      // 出典を明記する。二普協・都道府県警察の情報をもとに自前で区間を作っている
      attribution: "都道府県警察／日本二輪車普及安全協会の公開情報をもとに作成",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`  ⬆️  ${t.prefecture} → ${COLLECTION}/${t.data.romaji}`);
  }
  console.log(`\n完了（${targets.length}県）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
