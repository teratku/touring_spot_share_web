/**
 * restrictionOrigin.js
 *
 * 規制を**どの資料から作ったか**の記録と、**販売APIに載せてよいか**の判断。
 *
 * 【なぜ要るか】
 * ⚠️ **売ってはいけないデータがある。** 自社アプリで使うのと、APIとして売るのでは
 *    重みが違う。出どころごとに条件が違うので、1件ずつ記録しておかないと切り分けられない。
 *
 * 【出どころと条件（すべて原典を読んで確かめた）】
 *   jartic … JARTIC のオープンデータ。利用規約 第2条「商用利用も可能です」、
 *            第6条で **CC BY 4.0 と互換**。⚠️ 出典の記載と「加工した」旨の明記が条件。
 *   osm    … OpenStreetMap。**ODbL**。商用可だが「© OpenStreetMap contributors」の
 *            表示が義務（アプリ側は `OSMAttribution.swift` で守っている）。
 *   survey … 自分で標識を見て作ったもの。自前。
 *   jmpsa  … 二普協（日本二輪車普及安全協会）の一覧。
 *            ⚠️ **規約は「非営利目的ならリンク自由」で、データ転用の許諾ではない**
 *            （`fetchRestrictions.js` の注意書き）。**販売APIには載せない。**
 *
 * ⚠️ **記録が無いものも載せない。** いまある279件はすべて `origin` が無く、
 *    元が二普協か自前かを**あとから切り分けられない**。
 *    販売に載せるには JARTIC の候補から作り直すこと（47県・1,442件ある）。
 */
"use strict";

/** 記録してよい出どころ。⚠️ ここに無い値は保存時に落とす（憶測で埋めない） */
const ORIGINS = new Set(["jartic", "jmpsa", "osm", "survey"]);

/**
 * 販売APIに載せてよい出どころ。
 * ⚠️ **`jmpsa` を足さないこと。** 転用の許諾が無い（上の説明）。
 *    足すなら先に法務の判断を取ること。
 */
const SELLABLE_ORIGINS = new Set(["jartic", "osm", "survey"]);

/**
 * 候補の id から出どころを見分ける。
 *
 * ⚠️ **画面を変えずに埋めるための仕掛け。** 候補の id には取り込み側が
 *    前置きを付けている（`jartic-…` / `osm-<県>-…`）。登録でそれを引き継ぐ。
 * ⚠️ **分からないものは `null` のまま。** 憶測で `survey` などと書かない。
 *    「記録が無いものは売らない」という判断が、そこで効く。
 */
function originFromId(id) {
  const s = String(id || "");
  if (s.startsWith("jartic-")) return "jartic";
  if (s.startsWith("osm-")) return "osm";
  return null;
}

/** 保存するときの出どころ。渡された値を優先し、無ければ id から見分ける */
function normalizeOrigin(origin, id) {
  return ORIGINS.has(origin) ? origin : originFromId(id);
}

/** 販売APIに載せてよい規制か */
function isSellable(restriction) {
  return !!restriction && SELLABLE_ORIGINS.has(restriction.origin);
}

/**
 * 応答に必ず付ける出典。
 *
 * ⚠️ **義務。** OSM は ODbL で表示が要り、JARTIC は規約で出典と加工の明記を求めている。
 * ⚠️ **配信物のファイルには入っていなかった**（`data/road-recommend/*.json` も
 *    `data/road-restrictions/*.json` も）。Firestore へ上げるときだけ付いていた。
 *    **APIで配るなら応答そのものに入れること。**
 */
const ATTRIBUTION = [
  "© OpenStreetMap contributors（ODbL） https://www.openstreetmap.org/copyright",
  "出典：「交通規制情報」（公益財団法人日本道路交通情報センター）"
    + "（https://www.jartic.or.jp/service/opendata/）を加工して作成",
];

module.exports = {
  ORIGINS, SELLABLE_ORIGINS, ATTRIBUTION,
  originFromId, normalizeOrigin, isSellable,
};
