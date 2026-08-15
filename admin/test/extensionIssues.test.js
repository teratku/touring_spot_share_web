"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 「先へ延ばす」で出た線が変でないかの判定。
 *
 * ⚠️ つなぐ経路は最短で引かれるだけで、**道の続きを延ばしているとは限らない**。
 *    元の線を逆走して戻る／途中で行って戻りが入る／大回りする、が実際に起きる。
 *    当てる前に気付けるようにするための判定。
 *
 * ⚠️ ここは**弾かず、伝えるだけ**。道路網の都合でどうしても回り込む場所はあり、
 *    機械的に禁止すると直せなくなる。
 */
const html = fs.readFileSync(path.join(__dirname, "..", "public", "road-builder.html"), "utf8");
const parts = ["extensionIssues", "metersBetween", "hasBacktrack"].map((name) => {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} を取り出せない`);
  return m[0];
});
const consts = html.match(/const EXTEND_OVERLAP_METERS[\s\S]*?EXTEND_EXCESS_METERS = \d+;/)[0];
const extensionIssues = new Function(`${consts}\n${parts.join("\n")}\nreturn extensionIssues;`)();

/** 北へ進む線 */
const north = (count, lat0 = 35.0, lng = 139.0) =>
  [...Array(count)].map((_, i) => ({ lat: lat0 + i * 0.0002, lng }));

test("素直に先へ延びていれば何も言わない", () => {
  const existing = north(30);
  const added = north(30, 35.0 + 29 * 0.0002);          // 続きをそのまま北へ
  assert.deepStrictEqual(extensionIssues(existing, added, added[added.length - 1]), []);
});

test("元の道を逆走して戻ったら知らせる", () => {
  // ⚠️ これが「変に伸びる」の代表格。延ばしたつもりが元の道を二度走る形になる
  const existing = north(40);
  const added = [...existing].reverse();                 // 来た道をそのまま戻る
  const issues = extensionIssues(existing, added, added[added.length - 1]);
  assert.ok(issues.some((t) => t.includes("重なっています")), issues.join(" / "));
});

test("延ばした先で行って戻りが入れば知らせる", () => {
  const existing = north(20);
  const start = 35.0 + 19 * 0.0002;
  const out = north(30, start);                          // 先へ300mほど
  const added = [...out, ...out.slice().reverse()];       // 行って戻る
  const issues = extensionIssues(existing, added, out[out.length - 1]);
  assert.ok(issues.some((t) => t.includes("行って戻り")), issues.join(" / "));
});

test("大回りしていれば知らせる", () => {
  const existing = north(10);
  const from = existing[existing.length - 1];
  // 東へ大きく迂回してから、すぐ北の点へ戻ってくる
  const detour = [];
  for (let i = 0; i <= 60; i++) detour.push({ lat: from.lat, lng: from.lng + i * 0.0002 });
  for (let i = 60; i >= 0; i--) detour.push({ lat: from.lat + 0.0004, lng: from.lng + i * 0.0002 });
  const target = detour[detour.length - 1];
  const issues = extensionIssues(existing, detour, target);
  assert.ok(issues.some((t) => t.includes("遠回り")), issues.join(" / "));
});

test("少しだけ元の道をなぞるのは許す", () => {
  // ⚠️ つないだ線は、いったん少し戻ってから先へ向かうことがある（交差点の作りによる）。
  //    そこで毎回警告を出すと、まともな延長まで「変」と言われて役に立たない。
  //    ⚠️ **本当に重なる形で試すこと。** 端が1点触れるだけの線だと重なりが0mになり、
  //       許容値をいくつにしても通ってしまう（実際にそういうテストを書いてしまった）。
  const existing = north(40);
  const end = existing[existing.length - 1];
  const backTrack = [...existing.slice(37).reverse()];        // 元の道を60mほど戻る
  const forward = north(40, end.lat);                          // そこから先へ800mほど
  const added = [...backTrack, ...forward];
  const issues = extensionIssues(existing, added, forward[forward.length - 1]);
  assert.ok(!issues.some((t) => t.includes("重なっています")),
            "少し戻っただけで警告している: " + issues.join(" / "));
});

test("線が取れていなければその旨を返す", () => {
  assert.deepStrictEqual(extensionIssues(north(10), [], null), ["延ばす線が取れませんでした"]);
  assert.deepStrictEqual(extensionIssues(north(10), null, null), ["延ばす線が取れませんでした"]);
});

test("指した場所が無くても落ちない", () => {
  const existing = north(20);
  const added = north(20, 35.0 + 19 * 0.0002);
  assert.deepStrictEqual(extensionIssues(existing, added, null), []);
});
