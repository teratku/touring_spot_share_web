/**
 * restrictionTarget.js
 *
 * 「規制対象」の文言を、排気量の範囲に落とす。
 *
 * ⚠️ 「二輪禁止／原付禁止」の2〜4区分では足りない。実際の476件を見たら
 *    次のような範囲指定が普通に出てくる:
 *      「自動二輪（250cc超）」      37件 … 251cc以上だけ禁止
 *      「二輪(126cc以上を除く)」     3件 … 125cc以下だけ禁止
 *      「125cc以上400cc以下」       1件 … その範囲だけ禁止
 *    区分で持つと 250cc超の規制を125ccの人に出してしまう。範囲で持つ。
 *
 * ⚠️ 道路交通法の区分に合わせること。
 *    「原動機付自転車」は50cc以下（原付一種）。125cc以下は「小型自動二輪」で別。
 *    「一般原付」は特定原付（電動キックボード等）と区別するための新しい表記で、
 *    中身は従来の原付一種と同じ。
 */
"use strict";

/** 上限なしを表す値 */
const NO_MAX = 99999;

/**
 * 乗り手の排気量区分 → 範囲。アプリの BikeDisplacement と対応させる。
 * ここがずれると誰に警告するかがずれる。
 */
const RIDER_RANGES = {
  moped50:   [0, 50],
  small125:  [51, 125],
  medium250: [126, 250],
  large:     [251, NO_MAX],
};

/**
 * 規制対象の文言 → { minCc, maxCc, note }。
 * 二輪がまったく対象でなければ null（四輪だけの規制など）。
 */
function parseTarget(raw) {
  const t = String(raw || "").replace(/\s+/g, "").replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"));
  if (!t) return null;

  // --- 明示的な範囲指定を先に見る（「250cc超」など。区分より優先） ---
  const between = t.match(/(\d+)cc?以上(\d+)cc?以下/);
  if (between) return { minCc: Number(between[1]), maxCc: Number(between[2]), rule: "範囲指定" };

  const over = t.match(/(\d+)cc?(?:を)?超/);
  if (over) return { minCc: Number(over[1]) + 1, maxCc: NO_MAX, rule: "超" };

  // 「126cc以上を除く」＝ 125cc以下が対象
  const except = t.match(/(\d+)cc?以上(?:のもの)?を除く/);
  if (except) return { minCc: 0, maxCc: Number(except[1]) - 1, rule: "以上を除く" };

  const under = t.match(/(\d+)cc?以下/);
  if (under) {
    // 「自動二輪（125cc以下）を除く」のような打ち消しが無いか確かめる
    if (/以下(?:のもの)?を除く/.test(t)) {
      return { minCc: Number(under[1]) + 1, maxCc: NO_MAX, rule: "以下を除く" };
    }
    return { minCc: 0, maxCc: Number(under[1]), rule: "以下" };
  }

  // --- 車種の言葉から判断 ---
  const hasMotorcycle = /自動二輪|二輪の自動車|二輪車|(?<!四)輪(?!車を除く)/.test(t) || /^2?輪/.test(t) || t.includes("二輪");
  const hasMoped = /原動機付自転車|原付/.test(t);

  if (hasMotorcycle && hasMoped) return { minCc: 0, maxCc: NO_MAX, rule: "二輪全部" };
  // 「自動二輪車」だけ ＝ 51cc以上（原付一種は含まない）
  if (hasMotorcycle) return { minCc: 0, maxCc: NO_MAX, rule: "二輪" };
  // 「原動機付自転車」「一般原付」＝ 50cc以下
  if (hasMoped) return { minCc: 0, maxCc: 50, rule: "原付" };

  return null;   // 二輪は対象外（大型貨物だけ、など）
}

/** その規制が、この排気量区分の乗り手に当たるか */
function appliesToRider(target, riderKey) {
  if (!target) return false;
  const range = RIDER_RANGES[riderKey];
  if (!range) return false;
  return range[0] <= target.maxCc && range[1] >= target.minCc;
}

/** 表示用（「125cc以下が対象」など） */
function describe(target) {
  if (!target) return "二輪は対象外";
  if (target.minCc <= 0 && target.maxCc >= NO_MAX) return "二輪すべて";
  if (target.minCc <= 0) return `${target.maxCc}cc以下`;
  if (target.maxCc >= NO_MAX) return `${target.minCc}cc以上`;
  return `${target.minCc}〜${target.maxCc}cc`;
}

module.exports = { parseTarget, appliesToRider, describe, RIDER_RANGES, NO_MAX };
