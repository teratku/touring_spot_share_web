/**
 * roadNameMatcher.js
 *
 * 規制情報に書かれた道路名を、手元の道路データの道路名に突き合わせる。
 *
 * ⚠️ 二普協の表記は県ごとにバラバラで、そのままでは3割しか当たらない。
 *    実際に出てくるズレ:
 *      「国道357号 （国道）」   … 全角空白と括弧書きが付く
 *      「一般国道23号線」       … 「一般」が付き「線」で終わる
 *      「国道17号新大宮BP下り線地下道」… 後ろに構造物名がぶら下がる
 *      「神戸市道生田川鵯線」    … 「〇〇市道」が前に付く
 *    段階的に崩して当てにいく。どの段階で当たったかを返し、
 *    弱い当たり方（前方一致・部分一致）は開発者の確認を必須にする。
 */
"use strict";

/** 当て方の確からしさ。強いものから順に試す */
const CONFIDENCE = { exact: "確実", normalized: "ほぼ確実", stripped: "要確認", prefix: "要確認", partial: "要確認" };

/** 全角英数・空白・括弧を揃える */
function normalize(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
    .replace(/[　\s]/g, "")
    .trim();
}

/** 括弧書き・末尾の飾りを落とす */
function strip(value) {
  let v = normalize(value);
  v = v.replace(/\([^)]*\)/g, "");          // (国道) など
  v = v.replace(/^一般/, "");                // 一般国道23号線 → 国道23号線
  v = v.replace(/^主要地方道/, "県道");
  v = v.replace(/号線$/, "号");              // 国道23号線 → 国道23号
  return v.trim();
}

/**
 * 「神戸市道生田川鵯線」→「生田川鵯線」
 * 手元のデータは路線名だけで持っていることが多い
 */
function stripAdministrator(value) {
  return strip(value).replace(/^[^\s]{0,6}?(市道|町道|村道|府道|県道|都道|道道)/, "");
}

/** 「国道17号新大宮BP下り線地下道」→「国道17号」 */
function routeNumberOnly(value) {
  const m = strip(value).match(/^((?:国道|県道|府道|都道|道道|市道)?\d+号)/);
  return m ? m[1] : null;
}

/**
 * 道路名の索引を作る。
 * @param {Iterable<string>} names 手元の道路データにある名前
 */
function buildIndex(names) {
  const exact = new Set();
  const byNormalized = new Map();
  for (const raw of names) {
    if (!raw) continue;
    exact.add(raw);
    const n = normalize(raw);
    if (!byNormalized.has(n)) byNormalized.set(n, raw);
    const s = strip(raw);
    if (s && !byNormalized.has(s)) byNormalized.set(s, raw);
  }
  return { exact, byNormalized, names: [...exact] };
}

/**
 * 1件を当てる。
 * @returns {{ name, how, confidence }|null}
 */
function match(index, candidates) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);

  for (const c of list) if (index.exact.has(c)) return { name: c, how: "exact", confidence: CONFIDENCE.exact };
  for (const c of list) {
    const hit = index.byNormalized.get(normalize(c)) || index.byNormalized.get(strip(c));
    if (hit) return { name: hit, how: "normalized", confidence: CONFIDENCE.normalized };
  }
  for (const c of list) {
    const bare = stripAdministrator(c);
    if (bare && bare.length >= 3) {
      const hit = index.byNormalized.get(bare);
      if (hit) return { name: hit, how: "stripped", confidence: CONFIDENCE.stripped };
    }
  }
  for (const c of list) {
    const route = routeNumberOnly(c);
    if (route) {
      const hit = index.byNormalized.get(route);
      if (hit) return { name: hit, how: "prefix", confidence: CONFIDENCE.prefix };
    }
  }
  // 最後の手段。長い名前が含まれているものを探す（誤爆しやすいので確認必須）
  for (const c of list) {
    const s = strip(c);
    if (s.length < 5) continue;
    const hit = index.names.find((n) => n.includes(s) || s.includes(n) && n.length >= 5);
    if (hit) return { name: hit, how: "partial", confidence: CONFIDENCE.partial };
  }
  return null;
}

module.exports = { buildIndex, match, normalize, strip, stripAdministrator, routeNumberOnly, CONFIDENCE };
