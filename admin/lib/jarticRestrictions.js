/**
 * jarticRestrictions.js
 *
 * JARTIC（公益財団法人日本道路交通情報センター）の「交通規制情報」オープンデータから、
 * **二輪に効く規制**を取り出す（純ロジック。通信はしない）。
 *
 * 【なぜ要るか】
 * 曜日・時間つきの規制が、いままでどこからも取れなかった。
 * ⚠️ **OSM の日本データに曜日は0件**（神奈川0/223・大阪0/53で確認済み）。
 *    二普協（JMPSA）の一覧にも曜日は無い。JARTIC にはある。
 *    実測（大阪・2026年06月分）: 「自二輪 22:00〜06:00 通行禁止」のような規制が実在する。
 *
 * 【ここがいままでと違う】
 * ⚠️ **JARTIC は二次利用できる。** 利用規約（riyou_kiyaku.pdf）第2条:
 *      「どなたでも…複製、公衆送信、翻訳・変形等の翻案等、自由に利用できます。
 *        **商用利用も可能です。**」／第6条で **CC BY 4.0 と互換**。
 *    条件は**出典の記載**と、**加工したことの明記**:
 *      出典：「交通規制情報」（公益財団法人日本道路交通情報センター）（URL）（〇年〇月〇日に利用）
 *      上記を加工して作成
 *    ⚠️ **「JARTIC が作ったかのように」見せてはいけない**（規約に明記）。
 *    ⚠️ 二普協（`fetchRestrictions.js`）は「非営利ならリンク自由」だけで
 *       **転用の許諾ではない**。混同しないこと。あちらは下書き止まり、こちらは配信可。
 *
 * 【それでも置き換えにはならない】
 * ⚠️ **公安委員会の交通規制しか入っていない。** 実測: 石川県は二輪だけを対象とする
 *    規制が **46,628件中0件**。白山白川郷ホワイトロードの二輪通行止めは
 *    **道路事業者が定めたもの**で、交通規制ではないため JARTIC には無い。
 *    有料道路・林道・私道の規制は従来どおり手で登録すること。**足すもので、替えるものではない。**
 *
 * 【向きは入っていない】
 * ⚠️ 「禁止する方向(文字)」「進入方向(文字)」の列はあるが、**実測で0%**（山梨24,100件）。
 *    一方通行の向きを知りたいなら OSM の形と突き合わせて推定するしかない。
 *    ⚠️ GenNavi はその突き合わせのしきい値で19コミット費やしている。**ここには手を出さない。**
 */
"use strict";

/** 上限なし。`lib/restrictionTarget.js` と同じ値にすること */
const NO_MAX = 99999;

/**
 * 対象車両コードのカテゴリD（二輪・軽車両・歩行者）の桁位置 → 排気量の範囲。
 *
 * ⚠️ **値は「桁の位置」であって数値の大小ではない。** 仕様書の共通コード表では
 *    D の1桁目=二輪、2桁目=自二輪…と、**10進の桁位置がそのままビット**になっている
 *    （例: `1000` は4桁目＝原付）。加算して複数を表す（「共通コード番号を加算した値」）。
 *
 * ⚠️ 範囲は道路交通法の区分に合わせること（`restrictionTarget.js` と同じ考え方）。
 *      二輪   … 二輪の自動車＋原動機付自転車 → 全部
 *      自二輪 … 大型自動二輪車＋普通自動二輪車 → 51cc以上（原付を含まない）
 *      原付   … 一般原動機付自転車 → 50cc以下
 *      小二輪 … 125cc以下の普通自動二輪車 → 51〜125cc（原付は含まない）
 */
const VEHICLE_D = {
  1:  { name: "二輪",   minCc: 0,  maxCc: NO_MAX },
  2:  { name: "自二輪", minCc: 51, maxCc: NO_MAX },
  4:  { name: "原付",   minCc: 0,  maxCc: 50 },
  5:  { name: "小二輪", minCc: 51, maxCc: 125 },
};

/**
 * 共通規制種別コードのうち、**通行できなくなるもの**だけ。
 * ⚠️ 「車両通行区分帯」「原動機付自転車の右折方法(二段階)」なども二輪が対象になるが、
 *    **通れなくなるわけではない**ので入れない（実測: 山梨の二輪3件はすべて車両通行区分帯）。
 */
const BLOCKING_KINDS = new Set([
  "4",   // 通行止め
  "5",   // 車両通行止め
  "7",   // 車両通行止め(踏切)
]);

/**
 * 曜日コード → 1(月)〜7(日) の並びと、休日を含むか。
 * ⚠️ `lib/restrictionTime.js` の `normalizeDays` に合わせる（1=月 … 7=日）。
 * ⚠️ 99（その他）は**日付に落とせない**。捨てずに、そのまま人に見せる。
 */
const DAY_CODES = {
  "1": { days: [6, 7], holiday: false, label: "土曜・日曜" },
  "2": { days: [6, 7], holiday: true,  label: "土曜・日曜・休日" },
  "3": { days: [7],    holiday: true,  label: "日曜・休日" },
  "4": { days: [6],    holiday: false, label: "土曜日" },
  "5": { days: [7],    holiday: false, label: "日曜日" },
  "6": { days: [],     holiday: true,  label: "休日" },
  "99": { days: null,  holiday: false, label: "その他（規制内容を参照）" },
};

/**
 * 桁位置のビットを取り出す。`"1010"` → `{2, 4}`
 * ⚠️ 数値として扱わないこと。`Number("100000000000000")` は精度が足りる範囲だが、
 *    桁位置で見るほうが仕様そのままで読み違えない。
 */
function vehicleBits(value) {
  const v = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(v)) return new Set();
  const out = new Set();
  const rev = v.split("").reverse();
  for (let i = 0; i < rev.length; i++) if (rev[i] !== "0") out.add(i + 1);
  return out;
}

/**
 * 二輪が対象かどうかと、その排気量の範囲。
 *
 * ⚠️ **カテゴリAの「車両」（1桁目）は原付を含む**（仕様書: 1(車両)=2(自動車)+36(原付)+38(軽車両)）。
 *    つまり「車両通行止め」は二輪も通れない。ただし実測で神奈川だけで **36,588件**あり、
 *    その大半は生活道路の進入規制で、ツーリングの経路には関係しない。
 *    ここでは **二輪を名指ししている規制だけ**を返し、「車両」全般は `null` にする。
 *    （全般も要るなら別の窓口にすること。混ぜると人が確認しきれない）
 *
 * @returns {{minCc:number, maxCc:number, names:string[]}|null}
 */
function motorcycleTarget(row, index) {
  const bits = vehicleBits(row[`対象車両コード${index}_D`]);
  const hit = [...bits].filter((b) => VEHICLE_D[b]);
  if (!hit.length) return null;
  const ranges = hit.map((b) => VEHICLE_D[b]);
  return {
    minCc: Math.min(...ranges.map((r) => r.minCc)),
    maxCc: Math.max(...ranges.map((r) => r.maxCc)),
    names: ranges.map((r) => r.name),
  };
}

/**
 * 時間。`"2200"` `"600"` → `{ from: "22:00", to: "06:00" }`
 * ⚠️ **終日は `null`。** `0`〜`2400` は「いつでも」であって時間指定ではない。
 *    `restrictionTime.normalizeHours` も from===to を null にしている（同じ考え方）。
 */
function parseHours(start, end) {
  const hm = (v) => {
    const s = String(v == null ? "" : v).trim();
    if (!/^\d{1,4}$/.test(s)) return null;
    const n = Number(s);
    if (n === 2400) return "24:00";
    const p = s.padStart(4, "0");
    return `${p.slice(0, 2)}:${p.slice(2)}`;
  };
  const from = hm(start);
  const to = hm(end);
  if (!from || !to) return null;
  if (from === to) return null;
  if (from === "00:00" && to === "24:00") return null;      // 終日
  return { from, to };
}

/** 座標。`"138.5 35.7;138.6 35.8"` → `[[138.5, 35.7], [138.6, 35.8]]` */
function parseGeometry(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  for (const part of s.split(";")) {
    const m = part.trim().split(/\s+/);
    if (m.length < 2) continue;
    const lon = Number(m[0]);
    const lat = Number(m[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push([lon, lat]);
  }
  return out;
}

/**
 * 1行を、登録候補（`data/road-restrictions/*.json` と同じ形）に落とす。
 *
 * ⚠️ **そのまま配信しない。** ここで作るのは候補。JARTIC の区間は交通規制の単位で
 *    切られていて、アプリで見せたい「道」の単位とは限らない。
 *    road-builder の規制タブで地図を見て確認すること（二普協・OSM と同じ扱い）。
 *
 * @returns {object|null} 二輪に関係しない行・通れなくならない行は `null`
 */
function toCandidate(row, opts = {}) {
  const kindCode = String(row["共通規制種別コード"] || "").trim();
  if (!BLOCKING_KINDS.has(kindCode)) return null;

  // 規制1〜5のうち、二輪を名指ししている最初のもの
  for (let i = 1; i <= 5; i++) {
    const target = motorcycleTarget(row, i);
    if (!target) continue;

    const points = parseGeometry(row["規制場所の経度緯度"]);
    if (points.length < 2) return null;          // 線にならないものは地図で確かめられない

    const dayCode = String(row[`規制曜日コード${i}`] || "").trim();
    const day = DAY_CODES[dayCode] || null;

    return {
      // ⚠️ **JARTIC のユニークキーをそのまま持つ。** 翌月の更新で同じ規制を
      //    追いかけられるようにするため（前月ぶんは取得できなくなる）
      id: `jartic-${row["ユニークキー"]}`,
      kind: "noMotorcycle",
      name: String(row["路線名(代表)"] || row["交差点名称(踏切名含む)"] || "").trim() || null,
      prefecture: opts.prefecture || null,
      points,
      note: [row["県別規制種別名称"], row["規制条件"], row["規制内容"], row["備考"]]
        .map((x) => String(x || "").trim()).filter(Boolean).join(" / ") || null,
      activeMonths: null,
      activeDays: day ? day.days : null,
      includesHoliday: day ? day.holiday : false,
      activeHours: parseHours(row[`規制時間${i}_開始`], row[`規制時間${i}_終了`]),
      minCc: target.minCc,
      maxCc: target.maxCc,
      // 人が確かめるための手がかり
      jartic: {
        kindCode,
        kindName: String(row["県別規制種別名称"] || "").trim(),
        vehicles: target.names,
        dayLabel: day ? day.label : null,
        decidedAt: String(row["意思決定改正日"] || row["意思決定日(新規)"] || "").trim() || null,
      },
      source: "jartic",
    };
  }
  return null;
}

module.exports = {
  toCandidate, motorcycleTarget, vehicleBits, parseHours, parseGeometry,
  VEHICLE_D, BLOCKING_KINDS, DAY_CODES, NO_MAX,
};
