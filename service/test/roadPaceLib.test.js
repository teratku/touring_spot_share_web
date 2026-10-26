"use strict";
const test = require("node:test");
const assert = require("node:assert");
const L = require("../../public/road-pace-lib.js");
const F = require("../../functions/roadPace.js");

/**
 * Web の走りの速さ（road-pace-lib.js）は Cloud Functions の集計（functions/roadPace.js）と同じ答えを出すこと。
 * ⚠️ 利用者の判断（2026-10-26）: 開発者用ページは生の要約から同じ決まりで集計して見せる
 */
function rand(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

test("ランダムな要約で、関数と同じ集計になる", () => {
  const r = rand(42);
  const docs = [];
  for (let i = 0; i < 300; i++) {
    const uid = "u" + Math.floor(r() * 25);
    const roadID = "r:長野県|" + Math.floor(r() * 12) + "|primary";
    const rides = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({
      ym: "2026-10", km: Math.round(r() * 200) / 10, kmh: Math.round(10 + r() * 60), p85: Math.round(20 + r() * 60),
      stops: Math.floor(r() * 5), stopPct: Math.floor(r() * 40), cc: ["large", "small125", "moped50", "unknown"][Math.floor(r() * 4)],
    }));
    docs.push({ uid, roadID, roadName: "道" + roadID, rides });
  }
  for (const minUsers of [1, 3]) {
    const a = L.tally(docs, { minUsers }).map(({ sources, ...x }) => x);
    const b = F.tallyRoadPace(docs, { minUsers });
    assert.deepStrictEqual(a, b, `minUsers ${minUsers} で食い違う`);
  }
  assert.deepStrictEqual(L.LABELS, F.LABELS);
  assert.strictEqual(L.MIN_USERS, F.MIN_USERS);
});

test("出どころごとの回数（開発者用）と、鍵から県", () => {
  const out = L.tally([
    ...L.offlineDocs({ uid: "a", roads: { "s:秋田県:36": { name: "入道崎", rides: [{ km: 3, kmh: 40, p85: 50, stops: 0, stopPct: 1, cc: "unknown", src: "shared" }] } } }),
    { uid: "a", roadID: "s:秋田県:36", rides: [{ km: 3, kmh: 44, p85: 50, stops: 0, stopPct: 1, cc: "large" }] },
  ], { minUsers: 1 });
  assert.deepStrictEqual(out[0].sources, { shared: 1, app: 1 });
  assert.strictEqual(out[0].users, 1);
  assert.strictEqual(L.prefectureOfKey("r:長野県|152|primary"), "長野県");
  assert.strictEqual(L.prefectureOfKey("s:秋田県:36"), "秋田県");
  assert.strictEqual(L.prefectureOfKey("n:北海道|道道|tertiary"), "北海道");
});
