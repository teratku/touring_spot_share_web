"use strict";
/**
 * 方面（標識）の材料を、実際の Valhalla の応答から作る。
 *
 * ⚠️ **手で作らないこと。** 英字の混ざり方・前に付く空白・「帯広方面」のような
 *    名前そのものに「方面」が入る形は、実データを見て初めて分かった。
 *    手作りの材料では、それを壊しても落ちない。
 *
 * 作り直し方: admin で node makeSignFixtures.js（手元の Valhalla が要る）
 *
 * ⚠️ **`test/` に置かないこと。** Node 20 の `node --test test/` は、そこにある
 *    `.js` を**すべて実行する**。置いておくと、検査を回すたびに Valhalla を叩いて
 *    材料を書き換える（実際に `makeSpeedFixtures.js` が比べる土台を作り直していた）
 */
const fs = require("fs");
const path = require("path");
const { BASE } = require("./lib/valhallaRoute");

// [名前, 出発 [経度,緯度], 到着 [経度,緯度], 見どころ]
const 区間 = [
  ["東京→甲府", [139.7671, 35.6812], [138.5684, 35.6664], "英字の前に空白（' Enzan'）・首都高の出口"],
  ["札幌→苫小牧", [141.3544, 43.0621], [141.6055, 42.6343], "名前に「方面」が入る（帯広方面）"],
  ["大阪→名古屋", [135.4959, 34.7025], [136.8815, 35.1709], "4つ並ぶ・「近畿自動車道吹田方面」"],
  ["京都→神戸", [135.7588, 34.9858], [135.1780, 34.6795], "英字が混ざる・JCTの出口"],
  ["東京→箱根", [139.7671, 35.6812], [139.1069, 35.2324], "東名の分岐と出口"],
  ["岡山→広島", [133.9180, 34.6664], [132.4753, 34.3978], "5つ並ぶ・道路名が方面になる（岡山道）"],
  ["用賀→厚木", [139.6335, 35.6262], [139.3640, 35.4420], "海老名JCT。方面に出口の名前が入る（海老名出口）"],
];

const KEEP = ["type", "highway", "toll", "instruction", "street_names", "begin_street_names",
              "sign", "length", "verbal_transition_alert_instruction"];

(async () => {
  const out = {
    "⚠️ 何か": "Valhalla が返した maneuver をそのまま（使う項目だけ）置いたもの",
    "⚠️ 作り直し方": "admin で node makeSignFixtures.js",
    作成日: new Date().toISOString().slice(0, 10),
    区間: {},
  };
  for (const [name, from, to, note] of 区間) {
    const body = {
      locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }],
      costing: "motorcycle",
      // ⚠️ 高速を必ず通すため。方面は高速の分岐・出口にしか付かない
      costing_options: { motorcycle: { use_highways: 1.0 } },
      language: "ja-JP",
      directions_options: { units: "kilometers" },
    };
    const r = await (await fetch(`${BASE}/route`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!r.trip) { console.log(`  ⚠️ ${name} 失敗`, r.error); continue; }
    const maneuvers = r.trip.legs.flatMap((l) => l.maneuvers)
      .map((m) => Object.fromEntries(KEEP.filter((k) => k in m).map((k) => [k, m[k]])));
    const withToward = maneuvers.filter((m) => m.sign && m.sign.exit_toward_elements).length;
    out.区間[name] = { note, from, to, maneuvers };
    console.log(`  ${name.padEnd(8)} 指示${String(maneuvers.length).padStart(3)} 方面つき${String(withToward).padStart(3)}`);
  }
  fs.writeFileSync(path.join(__dirname, "test", "fixtures-nav-signs.json"), JSON.stringify(out, null, 1));
})();
