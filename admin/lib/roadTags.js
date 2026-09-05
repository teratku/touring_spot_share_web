/**
 * roadTags.js
 *
 * おすすめ道路に付ける「札」の鍵と、その日本語表示名。
 *
 * 【なぜ鍵にするか】
 * ⚠️ **札は配信データに入り、アプリで音声案内にそのまま乗る**
 *    （`NavigationEngine.swift:362`「札があれば、そのまま言い回しに乗せる」）。
 *    日本語のまま配ると、海外へ出したときに日本語が読み上げられる。
 *
 * ⚠️ **語彙が小さいうちに変えること。** 手で付けた札は 1,281件／12県 あるが、
 *    使われている語は7つだけ（実測）:
 *      快走1047 / ワインディング665 / 要注意158 / 林道ぎみ85 / 絶景25 / 砂利道4 / 行き止まり1
 *    札を付けた県が増えてからでは、変換が重くなる。
 *
 * 【移行のしかた】
 * ⚠️ **知らない札はそのまま通す。** 古い配信データや手入力の自由記述が来ても
 *    落とさない。アプリ側も「知らない鍵はそのまま出す」で揃える。
 */
"use strict";

/**
 * 鍵 → 日本語の表示名。
 *
 * ⚠️ **鍵を変えないこと。** 配信データに入り、アプリが持つ対応表と揃っている必要がある。
 *    表示名の方は自由に直してよい（アプリ側は自前の訳を持つ）。
 */
const TAG_LABELS_JA = {
  scenic: "絶景",
  winding: "ワインディング",
  flowing: "快走",
  forest: "林道ぎみ",
  caution: "要注意",
  gravel: "砂利道",
  deadend: "行き止まり",
  // ⚠️ 自由記述で付けられた語を後から足したもの（神奈川で1件）。
  //    ここに無いと日本語のまま配信データに乗り、海外で日本語が読み上げられる
  toll: "有料道路",
};

/** 画面のボタンに出す順番（よく使うものから） */
const PRESET_TAGS = ["scenic", "winding", "flowing", "forest", "caution", "gravel", "deadend"];

/**
 * 日本語 → 鍵。**既存の1,281件を変換するための対応表。**
 *
 * ⚠️ ここに無い日本語（自由記述）は変換しない。そのまま残す。
 */
const JA_TO_KEY = Object.fromEntries(
  Object.entries(TAG_LABELS_JA).map(([key, label]) => [label, key]),
);

/** 鍵かどうか */
const isTagKey = (tag) => Object.prototype.hasOwnProperty.call(TAG_LABELS_JA, tag);

/**
 * 札を鍵に直す。**知らないものはそのまま返す。**
 *
 * ⚠️ 二度掛けても壊れない。鍵は `JA_TO_KEY` に載っていないので、
 *    そのまま自分自身が返る（＝変換が途中で止まったファイルに掛け直せる）。
 */
function toKey(tag) {
  if (typeof tag !== "string") return tag;
  const trimmed = tag.trim();
  return JA_TO_KEY[trimmed] || trimmed;
}

/** 札の並びを鍵に直す（重複は落とす） */
function toKeys(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const key = toKey(t);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** 鍵 → 日本語。知らない鍵はそのまま返す（＝自由記述はそのまま出る） */
const labelJa = (key) => TAG_LABELS_JA[key] || key;

module.exports = { TAG_LABELS_JA, PRESET_TAGS, JA_TO_KEY, isTagKey, toKey, toKeys, labelJa };
