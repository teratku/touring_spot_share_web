/**
 * osmRestrictionTags.js
 *
 * OpenStreetMap のタグを、このツールの規制の形に読み替える（純ロジック）。
 *
 * 【なぜ必要か】
 * おすすめ道路は OSM 由来だが、二輪が通れるかどうかは見ていなかった。
 * そのため二輪通行禁止の道が「楽しい道」として配信されていた
 * （弥彦山スカイライン 83.3点／茨木能勢線 83.5点／白山白川郷ホワイトロード 70.9点）。
 * OSM 側には規制のタグが付いていることがあるので、それを候補として拾う。
 *
 * 【どこまで信じるか】
 * OSM の規制タグは、現地の標識を見た人が手で付けたもの。付いていない道の方が多い。
 * ⚠️ **ここで作るのは候補まで。** そのまま配信しない。区間の切れ目は OSM の都合で
 *    決まっていて、規制の実際の範囲とは限らない。
 *
 * 【読み替えの根拠】
 * 日本国内・実車道で実際に使われている `motorcycle:conditional` は6通りしかない
 * （Overpass で全国を数えて確認）。複数の時間帯を並べる書き方は韓国側にしか無い。
 *   no @ (Su,PH 00:00-06:00)                    51件  大阪生駒線
 *   no @ (Mo-Fr 07:30-09:00; Sa,Su,PH off)      11件  旧東海道
 *   no @ (21:00-05:00)                          11件  南田中町旭町線
 *   no @ (22:00-06:00)                           3件  秋田自動車道
 *   no @ (07:00-09:00)                           2件  中央通り
 *   destination @ 07:00-09:00                    1件  富士見通り（規制ではない）
 *
 * 原付だけ通れない道は `moped=no`（全国1,565本）。`moped:conditional` と `moped=private` は
 * 全国0件だったので、時間帯・私道の読み替えは要らない。値は `no` と `yes` の2つだけ。
 */
"use strict";

const { normalizeHours, normalizeDays } = require("./restrictionTime");

/** 曜日の綴り → 1=月 〜 7=日（`restrictionTime.js` と同じ並び） */
const DAY_NUMBERS = { Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 7 };

/** 原付が通れるとき、規制の下限に使う排気量 */
const MOPED_MAX_CC = 50;

/**
 * 自動車専用道路で通行できない上限。
 *
 * ⚠️ **原付二種（125cc以下）も入れない。** 標識が無くても道交法で決まっている。
 *    ふつうの道の「原付通行禁止」は50cc以下なので、切る位置が違う。
 *    一律50にすると、原付二種の人に通れない道（小田原厚木道路など）を勧めることになる。
 */
const MOTORROAD_MAX_CC = 125;

/** 時間帯（07:30-09:00）を拾う。前後の空白は許す */
const TIME_RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

/** "24:00" は 0時として扱う。OSM では終端に使われる */
function hm(hour, minute) {
  const h = Number(hour) === 24 ? 0 : Number(hour);
  return `${String(h).padStart(2, "0")}:${minute}`;
}

/**
 * 曜日の並び（"Mo-Fr" / "Su,PH" / "Sa,Su"）を読む。
 *
 * @returns {object|null} { days: number[], includesHoliday: boolean }。
 *          読めない綴りが混ざっていたら null（黙って一部だけ採らない）
 */
function parseDays(text) {
  const trimmed = text.trim();
  if (!trimmed) return { days: [], includesHoliday: false };

  const days = [];
  let includesHoliday = false;
  for (const token of trimmed.split(",")) {
    const item = token.trim();
    if (!item) continue;
    // PH=祝日、SH=学校休業日。SH は日本ではまず使われないので祝日と同じ扱いにはしない
    if (item === "PH") { includesHoliday = true; continue; }
    if (item === "SH") continue;

    const range = item.match(/^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/);
    if (range) {
      const from = DAY_NUMBERS[range[1]];
      const to = DAY_NUMBERS[range[2]];
      if (!from || !to) return null;
      // ⚠️ 週をまたぐ指定（Sa-Su ではなく Fr-Mo など）もあり得る。折り返して数える
      for (let d = from; ; d = (d % 7) + 1) {
        days.push(d);
        if (d === to) break;
      }
      continue;
    }
    const single = DAY_NUMBERS[item];
    if (!single) return null;
    days.push(single);
  }
  return { days: [...new Set(days)].sort((a, b) => a - b), includesHoliday };
}

/**
 * `motorcycle:conditional` の値を読む。
 *
 *   "no @ (Mo-Fr 07:30-09:00; Sa,Su,PH off)"
 *     → { value: "no", days: [1,2,3,4,5], includesHoliday: false,
 *         hours: { from: "07:30", to: "09:00" } }
 *
 * ⚠️ 読めなければ null を返す。**勝手に「終日禁止」にしないこと。**
 *    通れる時間まで禁止として配信してしまう。
 *
 * @returns {object|null}
 */
function parseConditional(text) {
  if (typeof text !== "string") return null;
  // ⚠️ 空白の無い書き方（"no@(Su,PH 00:00-04:00)"）が実在する。@ で割るだけにする
  const at = text.indexOf("@");
  if (at < 0) return null;
  const value = text.slice(0, at).trim().toLowerCase();
  if (!value) return null;

  let condition = text.slice(at + 1).trim();
  if (condition.startsWith("(") && condition.endsWith(")")) {
    condition = condition.slice(1, -1).trim();
  }
  if (!condition) return null;

  // ⚠️ "; Sa,Su,PH off" は前半の裏返しでしかない。読み飛ばす。
  //    拾ってしまうと「土日祝も規制」と逆の意味になる
  const rules = condition.split(";").map((r) => r.trim())
                         .filter((r) => r && !/\boff\b/i.test(r));
  if (rules.length !== 1) return null;
  const rule = rules[0];

  // 時間帯を先に抜き、残りを曜日として読む。
  // ⚠️ カンマは曜日の区切り（Su,PH）にも時間帯の区切り（07:00-09:00, 17:00-19:00）にも
  //    使われる。先に割ると "Su" と "PH 00:00-06:00" に分かれて読めなくなる
  TIME_RANGE.lastIndex = 0;
  const times = [...rule.matchAll(TIME_RANGE)];
  // ⚠️ 時間帯が2つ以上ある指定は表せない（`activeHours` は1区間だけ）。
  //    黙って片方を捨てると、残した側の外は通れることになってしまう
  if (times.length > 1) return null;

  const hours = times.length
    ? normalizeHours({ from: hm(times[0][1], times[0][2]), to: hm(times[0][3], times[0][4]) })
    : null;
  if (times.length && !hours) return null;   // 00:00-00:00 のような表せない指定

  const dayPart = rule.replace(TIME_RANGE, " ").replace(/,\s*(?=,|$)/g, "").trim();
  const parsed = parseDays(dayPart);
  if (!parsed) return null;

  return {
    value,
    days: parsed.days,
    includesHoliday: parsed.includesHoliday,
    hours,
  };
}

/**
 * OSM のタグ一式から、規制の候補に載せる中身を作る。
 *
 * @param {object} tags Overpass が返す way の tags
 * @returns {object} { blocks, kind, minCc, maxCc, activeDays, includesHoliday,
 *                     activeHours, targetLabel, reason, sourceTag }
 *          `blocks` が false のものは候補にしない
 */
function toCandidateFields(tags = {}) {
  const motorcycle = tags.motorcycle;
  const conditional = tags["motorcycle:conditional"];
  const none = {
    blocks: false, kind: null, minCc: null, maxCc: null,
    activeDays: null, includesHoliday: false, activeHours: null,
    targetLabel: null, reason: null, sourceTag: null,
  };

  // ⚠️ **私道は規制ではない。** motorcycle=private は「持ち主の許しが要る」の意味で、
  //    公安委員会が出した通行禁止とは別物。混ぜると候補が私道で埋まる。
  // ⚠️ 効くのは条件付きタグが併記されているときだけ（`private` 単独なら下の else で
  //    どのみち落ちる）。一度この判定を消しかけたが、条件付きで拾った way に
  //    private が乗ってくると規制として登録されてしまう
  if (motorcycle === "private") {
    return { ...none, reason: `私道（motorcycle=private）なので規制として扱わない` };
  }

  let activeDays = null;
  let includesHoliday = false;
  let activeHours = null;
  let reason = null;
  let sourceTag = null;
  /** 原付だけが対象か（二輪は通れる） */
  let mopedOnly = false;

  if (motorcycle === "no") {
    sourceTag = "motorcycle=no";
    // 終日。条件付きの例外（motorcycle:conditional=yes @ …）が併記されていたら、
    // 読み替えずに人に見せる。黙って終日にすると通れる時間まで禁止になる
    if (conditional && !/^\s*no\b/i.test(conditional)) {
      reason = `例外の指定がある: ${conditional}`;
    }
  } else if (conditional) {
    sourceTag = `motorcycle:conditional=${conditional}`;
    const parsed = parseConditional(conditional);
    if (!parsed) {
      // ⚠️ 読めなかったときは**時間を空にして、原文を残す**。
      //    値が no なら規制はあるので候補には出し、いつ効くかは人が入れる
      if (!/^\s*no\b/i.test(conditional)) {
        return { ...none, reason: `通行禁止ではない指定: ${conditional}` };
      }
      reason = `時間の指定を読めなかった。原文: ${conditional}`;
    } else if (parsed.value !== "no") {
      // ⚠️ destination は「用のある車は通れる」。禁止ではないので候補にしない。
      //    ここを規制として扱うと、走れる道がおすすめから消える
      return { ...none, reason: `通行禁止ではない指定: ${conditional}` };
    } else {
      activeDays = normalizeDays(parsed.days);
      includesHoliday = parsed.includesHoliday;
      activeHours = parsed.hours;
    }
    // ⚠️ `motor_vehicle=no` が併記されていたら、原付だけの話ではない。
    //    ここで拾うと上限50ccが付き、**251ccの人が通れることになってしまう**。下の枝に渡す
  } else if (tags.moped === "no" && tags.motor_vehicle !== "no") {
    // ⚠️ **原付だけ通れない道。** バイパス・一般有料道路に多く、`motorcycle=designated`
    //    （二輪はむしろ通れる）と併記されているのが普通の形。
    //    `motorcycle=no` しか見ていなかったので、この形をまるごと取りこぼしていた。
    //    神奈川県だけで324本あり、うち223本が `motorcycle=designated` 付き
    //    （小田原厚木道路・横浜新道・逗葉新道・真鶴道路・ターンパイク箱根・
    //      湯河原パークウェイ・芦ノ湖スカイライン）。
    //    実際、湯河原パークウェイ80.1点・芦ノ湖スカイライン76.5点・ターンパイク50.4点が
    //    神奈川県のおすすめに載っていて、原付の人に提案されていた。
    mopedOnly = true;
    sourceTag = "moped=no";
  } else if (tags.motor_vehicle === "no") {
    // ⚠️ **自動車が全部通れない道。二輪も当然通れない。**
    //    二輪だけのタグ（`motorcycle` / `moped`）が付いていないので、そこだけ見ていると
    //    **まるごと落ちる**。クエリでは取っていたのに、ここで捨てていた。
    //    実際、埼玉県は該当13本すべてがこの形で候補0件になっていた
    //    （秩父上名栗線・畑トンネル・林道清流線など。19県が同じ理由で空だった）。
    sourceTag = "motor_vehicle=no";
  } else {
    return none;   // 二輪についての指定が無い
  }

  // ⚠️ 車両全部が通れないなら「二輪通行禁止」ではなく「通行止め」。
  //    アプリ側の扱いが変わる（二輪だけの話ではないと伝わる）。
  // ⚠️ 原付だけの規制は別。上限50ccを付けているのに「通行止め」と言うと食い違う
  const kind = (!mopedOnly && tags.motor_vehicle === "no") ? "closed" : "noMotorcycle";

  // 原付は通れる、と別に書いてあるなら対象は51cc以上（京都の天の橋立線がこれ）。
  // ⚠️ moped=dismount は「降りて押せば通れる」であって、走っては通れない。下限を付けない
  const mopedAllowed = tags.moped === "yes" && !tags["moped:conditional"];
  const minCc = mopedAllowed ? MOPED_MAX_CC + 1 : null;
  // ⚠️ **上限を付け忘れないこと。** 付けないと「二輪すべて」になり、
  //    原付だけの規制で251ccの人のおすすめからも道が消える。
  // ⚠️ 自動車専用道路なら125cc以下。ふつうの道の原付規制（50cc以下）とは切る位置が違う
  const motorroad = tags.motorroad === "yes";
  const maxCc = !mopedOnly ? null : motorroad ? MOTORROAD_MAX_CC : MOPED_MAX_CC;

  // ⚠️ **ここで決めた排気量は当てにならない、と必ず伝えること。**
  //    OSM は `moped=no`（原付が通れない）としか書かず、**125cc以下なのか50cc以下なのかを
  //    区別できない**。実際に登録してみると125cc以下の道が多かった（報告あり）。
  //    `motorroad` も当てにならず、同じ道でも区間によって付いていたりいなかったりする
  //    （ターンパイク箱根で実際にそうなっている）。
  //    ⚠️ 曜日も同じ。OSM は持っていない（神奈川223本・大阪53本を調べて0件）。
  //       観光有料道路は土日祝だけ二輪通行禁止のことがあるが、それはここでは分からない。
  if (mopedOnly && !reason) {
    reason = motorroad
      ? "自動車専用道路として125cc以下にした。現地の標識で確かめること"
      : "原付だけの規制として50cc以下にした。自動車専用道路なら125cc以下、"
        + "観光有料道路なら土日祝だけ二輪通行禁止のことがある。現地の告知で確かめること";
  }

  return {
    blocks: true,
    kind,
    minCc,
    maxCc,
    activeDays,
    includesHoliday,
    activeHours,
    targetLabel: maxCc ? `${maxCc}cc以下` : minCc ? `${minCc}cc以上` : "二輪すべて",
    reason,
    sourceTag,
  };
}

module.exports = { parseConditional, parseDays, toCandidateFields,
                   DAY_NUMBERS, MOPED_MAX_CC, MOTORROAD_MAX_CC };
