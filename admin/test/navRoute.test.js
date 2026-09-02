"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { decode } = require("../lib/polyline");
const { STANDARD } = require("../lib/navGuide");

/**
 * ナビの窓口（`POST /api/nav/route`）。**アプリがそのまま食べられる形**か確かめる。
 *
 * ⚠️ **立ち上がっている管理ツールに向かって叩く。** 立っていなければ飛ばす
 *    （`node server.js` してから走らせること）。Valhalla も要る。
 */
const BASE = process.env.ADMIN_URL || "http://127.0.0.1:4317";
const KOFU = [138.5684, 35.6642];
const FUJI = [138.8087, 35.4876];

async function up() {
  try {
    const r = await fetch(`${BASE}/api/valhalla/status`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).up === true;
  } catch { return false; }
}
const skipIfDown = async (t) => (await up()) ? false
  : t.skip(`管理ツールか Valhalla が居ない（${BASE}）`);

async function ask(body) {
  const r = await fetch(`${BASE}/api/nav/route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  return r.json();
}

// MARK: 返す形

test("アプリの NavStep に要る鍵がそろっている", async (t) => {
  if (await skipIfDown(t)) return;
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large" });
  assert.ok(!res.error, `${res.error}`);

  for (const key of ["totalDistanceMeters", "totalDurationSeconds", "polyline", "steps"]) {
    assert.ok(key in res.route, `route に ${key} が無い`);
  }
  assert.ok(res.route.steps.length > 1, "指示が足りない");
  for (const step of res.route.steps) {
    // ⚠️ アプリの `NavStep` が読む鍵。1つでも欠けると向こうで落ちる
    for (const key of ["maneuver", "instruction", "distanceMeters", "durationSeconds",
                       "beginIndex", "endIndex", "isLegEnd"]) {
      assert.ok(key in step, `step に ${key} が無い: ${JSON.stringify(step)}`);
    }
    // 名前は無いことがあるので、鍵はあるが値は null でよい
    for (const key of ["roadName", "spokenRoad", "intersectionName", "isCurvyAhead"]) {
      assert.ok(key in step, `step に ${key} が無い`);
    }
  }
  assert.strictEqual(res.route.steps[res.route.steps.length - 1].isLegEnd, true,
    "最後の指示に終端の印が付いていない");
});

test("表示用と読み上げ用の名前を、別々に返す", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **取り違えると耳障りになる。** `roadName` は番号もローマ字も
  //    つないである（「舞鶴通り／Maiduru-dori／31」）。読み上げは `spokenRoad`
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large" });
  const joined = res.route.steps.filter((s) => s.roadName && s.roadName.includes("／"));
  assert.ok(joined.length > 0, "つないだ名前が1件も無い（材料が弱い）");
  for (const step of joined) {
    if (!step.spokenRoad) continue;
    assert.ok(!step.spokenRoad.includes("／"),
      `読み上げ用がつないだままになっている: ${step.spokenRoad}`);
  }
});

test("立ち寄り先があっても、番号が線からはみ出さない", async (t) => {
  // ⚠️ **アプリは範囲外の指示を黙って捨てる。**
  //    `ValhallaRouteService.parseStep` は `end < full.count` でなければ nil を返し、
  //    エラーも出ない。区間の先頭の点が重複で足されないぶんを数え忘れていたため、
  //    2区間目以降が丸ごと1つずれ、**最後の2指示が消えていた**。
  //    実測（新座→ドンキ→オギノパン）: 点1868に対し最大の番号1868。
  //    捨てられた中に1,618mの走る指示があり、最後の1.6kmが無案内だった
  if (await skipIfDown(t)) return;
  const res = await ask({ from: KOFU, vias: [[138.7, 35.55]], to: FUJI, stopAt: [0] });
  assert.ok(!res.error, `${res.error}`);
  const n = decode(res.route.polyline).length;
  assert.ok(res.route.steps.length > 2, "指示が少なすぎる（材料が悪い）");
  for (const [i, s] of res.route.steps.entries()) {
    assert.ok(s.beginIndex >= 0 && s.beginIndex < n,
      `指示${i} の始点 ${s.beginIndex} が線（${n}点）の外`);
    assert.ok(s.endIndex >= s.beginIndex && s.endIndex < n,
      `指示${i} の終点 ${s.endIndex} が線（${n}点）の外`);
  }
  // 最後の指示は線の終わりまで届いていること（1.6km 足りない、が起きない）
  const last = res.route.steps[res.route.steps.length - 1];
  assert.strictEqual(last.endIndex, n - 1,
    `最後の指示が線の終わりに届いていない（${last.endIndex} / ${n - 1}）`);
});

test("区間をまたいでも、指示の終点が地図の位置と合う", async (t) => {
  // ⚠️ ずれは1点ぶんなので「はみ出す」だけ見ると2区間目の中では気づけない。
  //    立ち寄り先の到着（距離0）は、経由地そのものの上に無ければおかしい
  if (await skipIfDown(t)) return;
  const via = [138.7, 35.55];
  const res = await ask({ from: KOFU, vias: [via], to: FUJI, stopAt: [0] });
  assert.ok(!res.error, `${res.error}`);
  const pts = decode(res.route.polyline);
  const ends = res.route.steps.filter((s) => s.isLegEnd);
  assert.strictEqual(ends.length, 2, `区間の終端が ${ends.length} 個（材料が悪い）`);
  const last = ends[ends.length - 1];
  const p = pts[last.endIndex];
  assert.ok(p, "最後の到着が線の外を指している");
  const d = Math.hypot((p[0] - FUJI[0]) * 90, (p[1] - FUJI[1]) * 111) * 1000;
  assert.ok(d < 300, `最後の到着が目的地から ${Math.round(d)}m ずれている`);
});

test("線は5桁で返す（10倍ずれない）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **Valhalla は6桁、アプリと Google は5桁。** そのまま渡すと座標が10倍ずれる。
  //    実際にこの取り違えをやったことがある
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large" });
  const points = decode(res.route.polyline);
  assert.ok(points.length > 100, `点が ${points.length} 個しかない`);
  const [lon, lat] = points[0];
  assert.ok(Math.abs(lat - KOFU[1]) < 0.05 && Math.abs(lon - KOFU[0]) < 0.05,
    `線の先頭が出発地とずれている: [${lon}, ${lat}]（出発地は [${KOFU}]）`);
  const last = points[points.length - 1];
  assert.ok(Math.abs(last[1] - FUJI[1]) < 0.05 && Math.abs(last[0] - FUJI[0]) < 0.05,
    `線の末尾が目的地とずれている: [${last}]`);
});

// MARK: 案内

test("案内が付いてくる", async (t) => {
  if (await skipIfDown(t)) return;
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large" });
  assert.ok(Array.isArray(res.guidance) && res.guidance.length > 5,
    `案内が ${res.guidance && res.guidance.length} 件しか無い`);
  for (const e of res.guidance) {
    for (const key of ["atMeters", "atSeconds", "stepIndex", "kind", "text"]) {
      assert.ok(key in e, `案内に ${key} が無い`);
    }
    assert.ok(e.text.trim(), "空の案内がある");
  }
  assert.deepStrictEqual(res.announce, { ...STANDARD },
    "既定の読み上げ設定が返っていない");
});

test("案内は要らないと言えば付けない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 長い経路では数百件になる。アプリは自分で組み立てるので要らない
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large", guidance: false });
  assert.strictEqual(res.guidance, undefined, "案内が付いてきている");
  assert.ok(res.route.steps.length > 1, "経路まで消えている");
});

test("読み上げ設定を変えると、案内の出かたが変わる", async (t) => {
  if (await skipIfDown(t)) return;
  const [standard, late] = await Promise.all([
    ask({ from: KOFU, to: FUJI, displacement: "large" }),
    ask({ from: KOFU, to: FUJI, displacement: "large",
          announce: { far: 0, near: 0, imminent: 50 } }),
  ]);
  assert.ok(late.guidance.length < standard.guidance.length,
    `遠め・近めを切ったのに案内が減っていない`
    + `（${standard.guidance.length} → ${late.guidance.length}）`);
  assert.ok(!late.guidance.some((e) => e.kind === "far" || e.kind === "near"),
    "切ったはずの遠め・近めが出ている");
  // ⚠️ **直前だけは必ず残る**（全部なしにしても曲がり損ねないため）
  assert.ok(late.guidance.some((e) => e.kind === "imminent"), "直前まで消えている");
});

// MARK: おすすめ道路

test("通す本数を言わなければ、おすすめ道路を足さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **素直な経路が要るときに、勝手に寄り道を足さない**
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large" });
  assert.deepStrictEqual(res.route.funRoads, [], "頼んでいないのに寄り道している");
});

test("本数を言えば、おすすめ道路を通す", async (t) => {
  if (await skipIfDown(t)) return;
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large",
                          avoidHighways: true, funCount: 4, budgetRatio: 2.0,
                          corridorScale: 1, minScore: 40 });
  assert.ok(res.route.funRoads.length > 0, "おすすめ道路が1本も通っていない");
  for (const road of res.route.funRoads) {
    for (const key of ["id", "name", "lengthKm", "start", "end"]) {
      assert.ok(key in road, `おすすめ道路に ${key} が無い`);
    }
  }
  assert.strictEqual(res.route.retracedMeters, 0,
    `往復が ${res.route.retracedMeters}m 残っている`);
});

test("おすすめ道路を通しても、往復を残さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **引いてみないと往復は分からない**（`lib/funRouteRefine.js`）。
  //    始末を飛ばすと、この区間は **往復24.8km** になる（実測）。
  //    ⚠️ 甲府→富士吉田では差が出ない。**広く回り込ませた区間で試すこと**
  //       （実測: 新座→愛川 24.8km / 高崎→草津 76.1km / 仙台→蔵王 10.5km）
  const res = await ask({ from: [139.57378, 35.79677], to: [139.26199, 35.55401],
                          displacement: "large", avoidHighways: true,
                          funCount: 8, budgetRatio: 2.0, corridorScale: 5, minScore: 40,
                          guidance: false });
  assert.ok(!res.error, `${res.error}`);
  assert.ok(res.route.funRoads.length > 0, "おすすめ道路が通っていない（材料が弱い）");
  assert.strictEqual(res.route.retracedMeters, 0,
    `往復が ${(res.route.retracedMeters / 1000).toFixed(1)}km 残っている`);
  assert.deepStrictEqual(res.route.backtracks, [], "折り返しが残っている");
});

test("往復は、返す線そのものから数える", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **始末をした結果を持ち回ってはいけない。** おすすめ道路を通さない
  //    経路は始末を通らないので、持ち回りだと**いつも0**になって嘘をつく
  const res = await ask({ from: [139.57378, 35.79677], to: [139.26199, 35.55401],
                          displacement: "large", guidance: false });
  assert.ok("retracedMeters" in res.route && "backtracks" in res.route,
    "おすすめ道路なしのとき、往復の欄が返っていない");
  assert.ok(Array.isArray(res.route.backtracks), "折り返しの一覧が配列でない");
});

// MARK: 走らせる前に知っておきたいこと

test("Uターン・往復・船・着いた側を返す", async (t) => {
  if (await skipIfDown(t)) return;
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large" });
  for (const key of ["uTurns", "retracedMeters", "arrivalUTurns", "ferryMeters",
                     "arrivedSide", "costing", "costingOptions"]) {
    assert.ok(key in res.route, `route に ${key} が無い`);
  }
  assert.strictEqual(res.route.ferryMeters, 0, "船に乗っている");
});

test("両端が無ければ断る", async (t) => {
  if (await skipIfDown(t)) return;
  const res = await ask({ from: KOFU });
  assert.ok(res.error, "目的地が無いのに引けてしまっている");
});

// MARK: 道の呼び方

test("道を番号の形で言う", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 「河口湖上九一色線」のような路線名は耳で追えない。
  //    道路標識に出ている番号なら走りながら確かめられる
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large",
                          avoidHighways: true, guidance: false });
  const numbered = res.route.steps.filter((s) => /号線$/.test(s.spokenRoad || ""));
  assert.ok(numbered.length > 0, "番号の形が1件も出ていない");
  for (const step of numbered) {
    assert.ok(/^(国道|都道|府道|道道|県道)\d+号線$/.test(step.spokenRoad),
      `形が違う: ${step.spokenRoad}`);
  }
});

test("県が付いてくる（都道と県道を言い分けるため）", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **東京で「県道」と言ってはいけない。** 県ごとに呼び方が変わるので、
  //    どの県を走っているかが要る
  const res = await ask({ from: [139.7671, 35.6812], to: [139.1069, 35.2324],
                          displacement: "large", avoidHighways: true, guidance: false });
  const prefectures = new Set(res.route.steps.map((s) => s.prefecture).filter(Boolean));
  assert.ok(prefectures.has("東京都") && prefectures.has("神奈川県"),
    `県をまたいでいるのに取れていない: ${[...prefectures].join(",")}`);
  for (const step of res.route.steps) {
    if (step.prefecture !== "東京都") continue;
    assert.ok(!/^県道/.test(step.spokenRoad || ""),
      `東京都で「${step.spokenRoad}」と言っている`);
  }
});

test("呼び方を、引き直さずに切り替えられる", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **番号が短いとは限らない**（実測: 読み上げ時間は全体で+5%）。
  //    聞き比べられるよう、経路を引き直さずに変えられること
  const res = await ask({ from: KOFU, to: FUJI, displacement: "large",
                          avoidHighways: true, guidance: false });
  const one = async (style) => {
    const r = await fetch(`${BASE}/api/nav/guidance`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: res.route.steps, roadNameStyle: style }),
    });
    return (await r.json()).guidance.map((e) => e.text).join("\n");
  };
  const numbered = await one("number");
  const named = await one("name");
  assert.notStrictEqual(numbered, named, "切り替えても案内が変わらない");
  assert.ok(/号線/.test(numbered), "番号の形が出ていない");
  assert.ok(!/(都道|府道|道道|県道)\d+号線/.test(named),
    "名前に戻したのに番号の形が混ざっている");
});
