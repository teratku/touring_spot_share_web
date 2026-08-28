/**
 * navName.js
 *
 * Valhalla の maneuver から、**読み上げに使う名前**を取り出す。
 *   ・入る道の名前（「〇〇へ左折です」の〇〇）
 *   ・曲がる交差点の名前（「〇〇交差点を左折です」の〇〇）
 *
 * ⚠️ **アプリの `NavRoadNameParser` / `NavIntersectionName` は移植しない。**
 *    あちらは **Google Directions の日本語指示文**が前提で、
 *    「〜に入る」「〇〇（交差点）を」といった Google 固有の言い回しを
 *    正規表現で探している。Valhalla はまったく別の返し方をするので、
 *    同じ規則は当たらない。**両方を混ぜないこと。**
 *
 * 【取れかたの比較（実測）】
 *                  アプリ（Google の文面から）   Valhalla
 *   道路名              74.3%                 **70.7%**（構造化されている。下記）
 *   交差点名            32.0%                 **38.8%**（構造化された欄には無い。下記）
 *
 * ⚠️ **Valhalla 自身の読み上げ文は使ってはいけない。** 日本語が壊れている。
 *      verbal_pre_transition_instruction: "右方向です。。その先左方向です。"
 *      verbal_post_transition_instruction: "明治通り, 305を4キロメートル直進です。"
 *    句点が二重になり、道路番号をそのまま読む。文言はこちらで組み立てる
 *    （`lib/navGuide.js`）。
 */
"use strict";

/**
 * 漢字・ひらがな・カタカナを含むか。
 *
 * ⚠️ **読み上げる名前を選ぶ判定はこれ。** `street_names` には
 *    番号・和名・ローマ字が混ざって返る:
 *      ["246","玉川通り","Tamagawa Street","一般国道246号","National Highway Route 246"]
 *    ⚠️ ローマ字には `Ōtsudōri` のように長音符が付くものがある。
 *       ASCII だけで判定すると弾けないので、**CJK を含むか**で見ること。
 */
function hasJapanese(text) {
  return /[぀-ヿ㐀-䶿一-鿿]/.test(text || "");
}

/**
 * 交差点の名前として不自然な、一般名詞。
 *
 * ⚠️ **実測で `分岐` を拾った**（「分岐を直進です」）。Valhalla は
 *    名前が無い分かれ道にもこの言い回しを使うので、名前として扱わない。
 */
const NOT_A_PLACE = new Set([
  "分岐", "出口", "入口", "ランプ", "料金所",
]);

/** 交差点名にしては長すぎるもの。⚠️ アプリの `NavIntersectionName` と同じ20文字 */
const MAX_NAME_LENGTH = 20;

/**
 * 名前の中の、ローマ字だけの括弧を落とす。
 *
 * ⚠️ **実測で見つけた形。** OSM の name にローマ字が同居していることがある:
 *      「中央通り (Chuo-dori)」 → 「中央通り」
 *    そのまま読ませると「ちゅうおうどおり しーえいちユーオー…」になる。
 * ⚠️ **中身に漢字かながある括弧は残すこと。**「狭山日高ＩＣ（西）」の
 *    「（西）」を落とすと別の場所を指す。
 */
function stripRomajiParens(name) {
  return name
    .replace(/\s*[（(]([^）)]*)[）)]\s*$/, (whole, inside) =>
      (hasJapanese(inside) ? whole : ""))
    .trim();
}

/** 名前の並びから、漢字かなを含むものを最初に1つ */
function firstJapanese(names) {
  for (const name of names || []) {
    if (typeof name !== "string") continue;
    const trimmed = stripRomajiParens(name.trim());
    if (trimmed && hasJapanese(trimmed)) return trimmed;
  }
  return null;
}

/**
 * 都道府県から、道路の呼び名を決める。
 *
 * ⚠️ **東京で「県道」と言ってはいけない。** 都道府県ごとに呼び方が違う。
 *    県が分からないときは `null`（＝番号の形に直さない）。適当に「県道」と
 *    言うくらいなら、路線名をそのまま読むほうがまし。
 */
function prefectureRoadWord(prefecture) {
  if (!prefecture) return null;
  if (prefecture === "東京都") return "都道";
  if (prefecture === "北海道") return "道道";
  if (prefecture === "京都府" || prefecture === "大阪府") return "府道";
  if (/[都道府県]$/.test(prefecture)) return "県道";
  return null;
}

/**
 * 高速・自動車道の名前か。
 *
 * ⚠️ **番号の形に直してはいけないもの。** 実測でこれらが「〜線」で終わる:
 *      首都高速3号渋谷線 / 阪神高速14号松原線 / 福岡都市高速2号太宰府線
 *    そのまま直すと「県道3号線」になり、**まったく別の道を指す。**
 */
function isExpresswayName(name) {
  return /高速|自動車道|有料道路|バイパス/.test(name || "");
}

/**
 * 読み上げる道路名（＝**曲がった先の道**の名前）を1つ選ぶ。
 *
 * ⚠️ **`begin_street_names` を先に見ること。** Valhalla では
 *      `street_names`       … その指示の**あいだ通して**変わらない名前
 *      `begin_street_names` … **曲がる地点**での名前（上と違うときだけ入る）
 *    「〇〇へ左折です」の〇〇は曲がる地点の名前なので、こちらが正しい。
 *    ⚠️ 逆順にすると番号しか残らない指示が増える。実測（7区間・曲がる116件）:
 *      `street_names` だけ    69件 (59.5%)
 *      `begin` → `street`    **82件 (70.7%)**
 *
 * 【番号の形に直す】
 * ⚠️ **路線名は読み上げに向かない。**「河口湖上九一色線」「主要地方道さいたま東村山線」
 *    のような二つの地名をつないだ名前が並び、耳で追えない。道路標識に出ている
 *    番号（「県道21号線」）のほうが、走りながら確かめられる。
 *    実測（8区間・路線名73種）: **23%が7字以上**、最長13字。
 *    ⚠️ ただし**短くなるとは限らない**（「原宿山野線」→「県道318号線」）。
 *       短さではなく「標識と一致する」ことが利点。
 *
 * ⚠️ **国道と路線名は同居しない。** 396件の指示で1件も無かったので、
 *    「〜線 ＋ 番号」なら都道府県道と見なしてよい。
 * ⚠️ **高速だけは別**（`isExpresswayName` を読むこと）。
 *
 * ⚠️ **番号だけのときは名前を言わない。** 「358へ左折です」は意味が通らないし、
 *    国道か県道かも分からないので補えない（実測: 曲がる指示の12.1%）。
 *
 * 【読み上げ時間の実測（ブラウザの読み上げで実際に計った）】
 * ⚠️ **短くなるとは限らない。番号の桁数で逆転する。**
 *   主要地方道さいたま東村山線 3051ms → 県道40号線  1747ms  **−1304ms**
 *   河口湖上九一色線          2504ms → 県道21号線  1848ms   **−656ms**
 *   東京都道一七六号線        2722ms → 都道176号線 2133ms   **−589ms**
 *   笛吹市川三郷線           1694ms → 県道36号線  2036ms    +342ms
 *   原宿山野線              1396ms → 県道318号線 2389ms    +993ms
 *   玉川通り                1024ms → 国道246号線 2447ms   +1423ms
 *   ──────────────────────────────────────────
 *   合計                  14290ms → 14935ms   **+645ms（+5%）**
 *
 *   3桁の番号は「さんびゃくじゅうはち」と読むので長い。**短い通称には勝てない。**
 *   それでも番号を既定にしているのは、**道路標識と一致していて走りながら
 *   確かめられる**ため。`style: "name"` で従来どおりの名前にも戻せる。
 *
 * @param {object} maneuver Valhalla の maneuver
 * @param {object} [opts]   { prefecture, style }
 *   `style`: `"number"`（既定・番号の形）/ `"name"`（名前をそのまま）
 * @returns {string|null}
 */
function spokenRoadName(maneuver, opts = {}) {
  if (!maneuver) return null;
  // ⚠️ **生の maneuver でも、名前だけの並びでも受ける。** 経路を引き直さずに
  //    呼び方を切り替えられるようにするため（`steps[].roadNames` を渡す）
  const raw = Array.isArray(maneuver) ? maneuver
    : [...(maneuver.begin_street_names || []), ...(maneuver.street_names || [])];
  const names = raw.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim());
  if (opts.style === "name") return firstJapanese(names);

  // ⚠️ 高速は番号に直さない。そのままの名前で読む
  if (!names.some(isExpresswayName)) {
    for (const name of names) {
      const kokudo = name.match(/(?:一般)?国道\s*(\d+)\s*号/);
      if (kokudo) return `国道${kokudo[1]}号線`;
    }
    const word = prefectureRoadWord(opts.prefecture);
    const ref = names.find((n) => /^\d+$/.test(n));
    const routeName = names.find((n) => hasJapanese(n) && /線$/.test(n));
    if (word && ref && routeName) return `${word}${ref}号線`;
  }

  return firstJapanese(names);
}

/**
 * 曲がる交差点の名前を取り出す。
 *
 * ⚠️ **`sign` には入っていない。** 実測で `sign` に入るのは高速の出口だけ
 *    （`exit_number_elements` / `exit_toward_elements` / `exit_name_elements` /
 *      `exit_branch_elements`）。交差点名は0件だった。
 *
 * ⚠️ **`verbal_transition_alert_instruction` の中にしか無い。**
 *    「新宿四丁目を右方向です。」の「を」の前。ただし同じ言い回しは
 *    **道路名にも使われる**（「甲州街道を東方向です。」）ので、
 *    `street_names` / `begin_street_names` と照らして切り分ける。
 *
 * 【実測（7区間・曲がる指示116件）】
 *   45件（**38.8%**）で取れた。アプリの Google 経由 32.0% より少し多い。
 *   取れた例: 新宿四丁目 / 室町三丁目 / 栄 / 甲府警察署東 / NTT甲府支店西 /
 *            太田町南 / 森の上 / 富士吉田警察署前 / 市役所前 / 野火止下 / 長命寺前
 *
 * @returns {string|null}
 */
function intersectionName(maneuver) {
  if (!maneuver) return null;
  const alert = maneuver.verbal_transition_alert_instruction || "";
  const at = alert.indexOf("を");
  if (at <= 0) return null;

  const head = alert.slice(0, at).trim();
  if (!head || head.length > MAX_NAME_LENGTH) return null;
  if (NOT_A_PLACE.has(head)) return null;

  // ⚠️ **道路名と同じものは交差点名ではない。** 「甲州街道を東方向です」の
  //    「甲州街道」は入る道であって、曲がる場所ではない。
  //    ⚠️ 片方がもう片方を含むことがある（"玉川通り" と "246/玉川通り"）ので
  //       完全一致だけで見ないこと。
  const roads = [...(maneuver.street_names || []),
                 ...(maneuver.begin_street_names || [])];
  for (const road of roads) {
    if (typeof road !== "string" || !road) continue;
    if (head === road || head.includes(road) || road.includes(head)) return null;
  }
  return head;
}

/**
 * 交差点名を読み上げる形にする。
 *
 * ⚠️ **既に「交差点」「三差路」などが入っている名前がある**（実測: 長竹三差路）。
 *    そのまま足すと「長竹三差路交差点」になる。アプリの
 *    `NavIntersectionName.spoken` と同じ扱いにすること。
 */
const ALREADY_NAMED = ["交差点", "三差路", "四差路", "五差路",
                       "丁字路", "T字路", "ロータリー", "ＩＣ", "IC", "JCT"];

function spokenIntersection(name) {
  if (!name) return null;
  if (ALREADY_NAMED.some((suffix) => name.endsWith(suffix))) return name;
  return `${name}交差点`;
}

module.exports = {
  spokenRoadName, intersectionName, spokenIntersection, firstJapanese, stripRomajiParens,
  prefectureRoadWord, isExpresswayName,
  hasJapanese, NOT_A_PLACE, MAX_NAME_LENGTH,
};
