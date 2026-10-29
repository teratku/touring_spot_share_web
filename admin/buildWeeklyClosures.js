/**
 * buildWeeklyClosures.js
 *
 * X の毎週の投稿「今週閉まる道」の画像（1600×900）と投稿文を作る。本番の road_restrictions を**読むだけ**。
 *
 * ⚠️ 利用者の要望（2026-10-28）:「今週閉まる道の画像を毎週自動で作る仕組みを作る」。毎週水曜の予定の作業がこれを走らせ、
 *    画像と文を利用者に送る（投稿は利用者が X で予約する）。木曜 21時の投稿に合わせて、期間は**明日から8日**（木〜翌木）
 * ⚠️ 見た目は X の告知画像（iOS repo tools/x-posts/compose.swift）にそろえる: 青緑のグラデーション・ヒラギノ・左下にアイコン
 * ⚠️ 選び方は lib/weeklyClosures.js（今冬の発表が無い道は「例年」）
 *
 *   node buildWeeklyClosures.js                    # 明日から8日
 *   node buildWeeklyClosures.js --from 2026-11-05  # 日付を指定（試すとき）
 *   node buildWeeklyClosures.js --from 2027-04-15 --days 8
 *
 * 出力: generated/weekly-closures/<始まりの日>/card.png・card.html・post.txt（git には入れない）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const admin = require("firebase-admin");
const { weeklyClosures, postText } = require("./lib/weeklyClosures");

const PROJECT_ID = "biketeilen";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ICON = path.join(__dirname, "..", "public", "icon-512.png");
const LIST_URL = "biketeilen.web.app/winter-closures.html";
const MAX_ROWS = 6;

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadRestrictions() {
  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, "serviceAccount.json");
    admin.initializeApp({ projectId: PROJECT_ID,
      credential: fs.existsSync(keyPath) ? admin.credential.cert(require(keyPath)) : admin.credential.applicationDefault() });
  }
  const snap = await admin.firestore().collection("road_restrictions").get();
  const out = [];
  for (const d of snap.docs) {
    const x = d.data();
    for (const r of x.restrictions || []) out.push(Object.assign({ prefecture: x.prefecture }, r));
  }
  return out;
}

function rowHtml(x, kind) {
  const tag = x.usual ? `<span class="tag usual">例年の日付</span>` : `<span class="tag fixed">発表済み</span>`;
  return `<div class="row ${kind}">
    <div class="date"><b>${esc(x.dateLabel)}</b><span>${x.hour ? esc(x.hour) + "から" : ""}${kind === "open" ? "開通" : "閉鎖"}</span></div>
    <div class="name"><b>${esc(x.name)}</b><span>${esc(x.prefecture)}</span></div>${tag}</div>`;
}

/** 画像の HTML。今週の道を最大6行・残りは「ほか n本」・余った行に「その先2週間」を小さく */
function cardHtml(week, later) {
  const rows = [...week.closing.map((x) => [x, "close"]), ...week.reopening.map((x) => [x, "open"])]
    .sort((a, b) => a[0].date - b[0].date);
  // ⚠️ 入りきらないときは「ほか n本」に1行使う（6行＋ほか だとはみ出して左下のアイコンを押し下げる）
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS - 1) : rows;
  const more = rows.length - shown.length;
  const room = MAX_ROWS - shown.length - (more ? 1 : 0);
  // 「その先」は2行ぶんの枠に最大3本（空きが2行以上あるときだけ）
  const next = room < 2 ? [] : [...later.closing.map((x) => [x, "close"]), ...later.reopening.map((x) => [x, "open"])]
    .sort((a, b) => a[0].date - b[0].date).slice(0, 3);
  const title = week.closing.length || !week.reopening.length ? "今週閉まる道" : "今週開く道";
  const icon = fs.existsSync(ICON) ? `data:image/png;base64,${fs.readFileSync(ICON).toString("base64")}` : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1600px;height:900px;overflow:hidden}
  body{font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif;color:#fff;
    background:linear-gradient(180deg,#00A8C6 0%,#00546E 100%);display:grid;grid-template-columns:470px 1fr;grid-template-rows:minmax(0,1fr);gap:56px;padding:64px 72px 56px}
  .head{display:flex;flex-direction:column;gap:20px}
  .kicker{font-weight:600;font-size:28px;letter-spacing:.12em;opacity:.85}
  h1{font-weight:800;font-size:76px;line-height:1.1;letter-spacing:-.01em;white-space:nowrap}
  .range{font-weight:700;font-size:34px;font-variant-numeric:tabular-nums}
  .lead{font-weight:400;font-size:24px;line-height:1.6;opacity:.9;margin-top:6px}
  .brand{margin-top:auto;display:flex;align-items:center;gap:18px}
  .brand img{width:84px;height:84px;border-radius:19px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
  .brand b{display:block;font-weight:800;font-size:26px;white-space:nowrap}
  .brand span{display:block;font-size:17px;opacity:.85;margin-top:3px;white-space:nowrap}
  .list{display:grid;grid-auto-rows:112px;gap:12px;align-content:center;min-width:0}
  .row{display:grid;grid-template-columns:230px 1fr auto;align-items:center;gap:22px;
    background:rgba(255,255,255,.96);color:#0B3A48;border-radius:18px;padding:0 24px;min-width:0}
  .date{display:flex;flex-direction:column;font-variant-numeric:tabular-nums}
  .date b{font-weight:800;font-size:36px;color:#00546E}
  .date span{font-weight:700;font-size:19px;letter-spacing:.06em;color:#B23A2E;margin-top:2px}
  .row.open .date span{color:#1F7A4A}
  .name{min-width:0}
  .name b{display:block;font-weight:800;font-size:36px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .name span{display:block;font-size:21px;color:#4F6F78;margin-top:4px}
  .tag{font-weight:700;font-size:19px;border-radius:999px;padding:7px 16px;white-space:nowrap}
  .tag.fixed{background:#00546E;color:#fff}
  .tag.usual{background:#E6EEF0;color:#4F6F78}
  .more{font-weight:700;font-size:26px;padding:0 8px;align-self:center}
  .later{display:flex;flex-direction:column;justify-content:center;gap:4px;padding:0 8px;grid-row:span 2}
  .later h2{font-weight:700;font-size:22px;letter-spacing:.08em;opacity:.85}
  .later p{font-size:24px;font-variant-numeric:tabular-nums}
  .later p b{font-weight:800;margin-right:14px}
  </style></head><body>
  <div class="head">
    <div class="kicker">冬季閉鎖カレンダー</div>
    <h1>${title}</h1>
    <div class="range">${esc(week.range.label)}</div>
    <div class="lead">${week.closing.length ? "走りおさめはお早めに。" : "今シーズンの走りはじめに。<br>開通直後は夜間通行止めの道もあります。"}<br>日付・時刻は道路管理者の発表で<br>確かめてください。</div>
    <div class="brand">${icon ? `<img src="${icon}" alt="">` : ""}<div><b>ツーリングスポットシェア</b><span>全国の一覧は Web で</span><span>${LIST_URL}</span></div></div>
  </div>
  <div class="list">
    ${shown.map(([x, k]) => rowHtml(x, k)).join("\n")}
    ${more ? `<div class="more">ほか ${more}本 → 一覧は Web で</div>` : ""}
    ${next.length ? `<div class="later"><h2>その先の2週間</h2>${next.map(([x, k]) =>
      `<p><b>${esc(x.dateLabel)}</b>${esc(x.name)}${k === "open" ? " 開通" : ""}${x.usual ? "（例年）" : ""}</p>`).join("")}</div>` : ""}
  </div>
  </body></html>`;
}

async function main() {
  const from = arg("--from") ? new Date(arg("--from") + "T00:00:00") : (() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1); })();
  const days = Number(arg("--days") || 8);
  const all = await loadRestrictions();
  const week = weeklyClosures(all, from, days);
  const laterFrom = new Date(week.range.to.getFullYear(), week.range.to.getMonth(), week.range.to.getDate() + 1);
  const later = weeklyClosures(all, laterFrom, 14);
  const count = week.closing.length + week.reopening.length;
  console.log(`${week.range.label}: 閉まる ${week.closing.length}本・開く ${week.reopening.length}本（冬季閉鎖 ${all.filter((r) => r.kind === "winterClosure").length}件から）`);
  if (!count) { console.log("今週は閉まる道・開く道がありません。画像は作りません"); return; }

  const dir = path.join(__dirname, "generated", "weekly-closures", ymd(from));
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(dir, "card.html");
  const png = path.join(dir, "card.png");
  fs.writeFileSync(html, cardHtml(week, later));
  // ⚠️ 倍率を1に固定（Retina の2倍で 3200×1800 にしない）。使い捨てのプロファイルで、普段の Chrome と混ぜない
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--user-data-dir=${path.join(dir, ".chrome")}`, "--window-size=1600,900", `--screenshot=${png}`, "file://" + html],
    { stdio: "ignore" });
  fs.rmSync(path.join(dir, ".chrome"), { recursive: true, force: true });
  const text = postText(week, { url: `https://${LIST_URL}` });
  fs.writeFileSync(path.join(dir, "post.txt"), text + "\n");
  for (const x of [...week.closing, ...week.reopening]) console.log(`  ${x.dateLabel} ${x.hour} ${x.name}（${x.prefecture}）${x.usual ? " 例年" : ""}`);
  console.log(`\n${png}\n${path.join(dir, "post.txt")}\n\n${text}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
