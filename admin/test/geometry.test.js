"use strict";
const test = require("node:test");
const assert = require("node:assert");

const { distanceMeters, parseWkt, parseCsvLine } = require("../lib/roadCsv");
const { bearing, angleDelta, profile, simplify, encode, decode } = require("../lib/polyline");
const { stitch } = require("../lib/roadStitcher");
const { extract, score, signals, EXTRACT } = require("../lib/funSegments");

// 東京付近を基準に、まっすぐ north へ伸びる線を作る
const LAT0 = 35.68;
const LNG0 = 139.77;
const M_PER_LAT = 111320;
const M_PER_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const pt = (eastM, northM) => [LNG0 + eastM / M_PER_LNG, LAT0 + northM / M_PER_LAT];

// ---------------------------------------------------------------- CSV
test("CSV: 引用符の中のカンマを区切りにしない", () => {
  const fields = parseCsvLine('123,国道1号,primary,1,"LINESTRING (139.7 35.6, 139.8 35.7)"');
  assert.strictEqual(fields.length, 5);
  assert.strictEqual(fields[1], "国道1号");
  assert.ok(fields[4].includes("139.8 35.7"));
});

test("CSV: エスケープされた引用符", () => {
  const fields = parseCsvLine('1,"あ""い",x');
  assert.strictEqual(fields[1], 'あ"い');
});

test("WKT: 2点未満は捨てる", () => {
  assert.strictEqual(parseWkt("LINESTRING (139.7 35.6)"), null);
  assert.strictEqual(parseWkt(""), null);
  assert.strictEqual(parseWkt("POINT (1 2)"), null);
  assert.strictEqual(parseWkt("LINESTRING (139.7 35.6, 139.8 35.7)").length, 2);
});

// ---------------------------------------------------------------- 角度
test("方位: 北0 / 東90 / 南180 / 西-90", () => {
  assert.ok(Math.abs(bearing(pt(0, 0), pt(0, 100)) - 0) < 0.5);
  assert.ok(Math.abs(bearing(pt(0, 0), pt(100, 0)) - 90) < 0.5);
  assert.ok(Math.abs(Math.abs(bearing(pt(0, 0), pt(0, -100))) - 180) < 0.5);
  assert.ok(Math.abs(bearing(pt(0, 0), pt(-100, 0)) + 90) < 0.5);
});

test("角度差: 境界をまたいでも最短側を返す", () => {
  assert.strictEqual(angleDelta(170, -170), 20);
  assert.strictEqual(angleDelta(-170, 170), -20);
  assert.strictEqual(angleDelta(0, 90), 90);
});

test("profile: 点の揺れを曲率と数えない（まっすぐな道が峠に化けないように）", () => {
  // 1m 刻みで 0.5m 横に振れているだけの直線 200m
  const noisy = [];
  for (let i = 0; i < 200; i++) noisy.push(pt(i % 2 === 0 ? 0 : 0.5, i * 1));
  const p = profile(noisy);
  assert.ok(p.points.length <= 3, `揺れが残っている: ${p.points.length}点`);
  assert.ok(p.totalTurnDegrees < 5, `ギザギザが曲率として残った: ${p.totalTurnDegrees.toFixed(0)}度`);
});

test("profile: 本物のカーブは残す（ヘアピンを平らにしない）", () => {
  // 半径150mの180度カーブ。総曲がり角は 180度のはず
  const hairpin = [];
  for (let a = 0; a <= 180; a += 2) {
    const r = (a * Math.PI) / 180;
    hairpin.push(pt(150 * Math.sin(r), 150 * (1 - Math.cos(r))));
  }
  const p = profile(hairpin);
  // 頂点で測る以上、最初と最後の半辺ぶんは構造的に数えられない
  // （n辺の折れ線で近似すると理論値の (n-1)/n になる）。8割残っていれば十分。
  assert.ok(p.totalTurnDegrees > 180 * 0.8,
            `ヘアピンの曲がりが失われた: ${p.totalTurnDegrees.toFixed(0)}度`);
  assert.ok(p.totalTurnDegrees <= 181, `曲がりすぎ: ${p.totalTurnDegrees.toFixed(0)}度`);
});

test("profile: 緩いカーブでも総曲がり角が保たれる（点密度に左右されない）", () => {
  // 半径500mを1km。理論値は 1000/500 rad = 114.6度
  const build = (stepDeg) => {
    const out = [];
    for (let a = 0; a <= 114.6; a += stepDeg) {
      const r = (a * Math.PI) / 180;
      out.push(pt(500 * Math.sin(r), 500 * (1 - Math.cos(r))));
    }
    return out;
  };
  const dense = profile(build(0.5)).totalTurnDegrees;
  const sparse = profile(build(4)).totalTurnDegrees;
  // 元の点が8倍違っても答えがほぼ変わらないこと（これが狙い）。
  // 間引きで残る頂点数がわずかに前後するぶん、数%はずれる。順位付けには影響しない範囲。
  assert.ok(Math.abs(dense - sparse) / dense < 0.08,
            `点密度で結果が変わりすぎる: ${dense.toFixed(0)} vs ${sparse.toFixed(0)}`);
  assert.ok(dense > 114.6 * 0.8, `密: ${dense.toFixed(0)}度`);
  assert.ok(sparse > 114.6 * 0.8, `疎: ${sparse.toFixed(0)}度`);
});

test("profile: 直線は曲がり角0、直角は90度", () => {
  const straight = profile([pt(0, 0), pt(0, 500), pt(0, 1000)]);
  assert.ok(straight.totalTurnDegrees < 0.5);
  const corner = profile([pt(0, 0), pt(0, 500), pt(500, 500)]);
  assert.ok(Math.abs(corner.totalTurnDegrees - 90) < 1, `${corner.totalTurnDegrees}`);
});

test("profile: 累積距離が実距離と合う", () => {
  const p = profile([pt(0, 0), pt(0, 1000), pt(0, 2000)]);
  assert.ok(Math.abs(p.totalMeters - 2000) < 5, `${p.totalMeters}`);
});

// ---------------------------------------------------------------- 間引き
test("simplify: 両端は必ず残る", () => {
  const points = [];
  for (let i = 0; i <= 100; i++) points.push(pt(0, i * 10));
  const out = simplify(points, 50);
  assert.deepStrictEqual(out[0], points[0]);
  assert.deepStrictEqual(out[out.length - 1], points[points.length - 1]);
  assert.strictEqual(out.length, 2, "直線なら中間は全部落ちる");
});

test("simplify: 許容値より大きいズレは残す", () => {
  const points = [pt(0, 0), pt(200, 500), pt(0, 1000)];
  assert.strictEqual(simplify(points, 50).length, 3);
  assert.strictEqual(simplify(points, 500).length, 2);
});

test("simplify: 長い線でもスタックを使い切らない", () => {
  const points = [];
  for (let i = 0; i < 50000; i++) points.push(pt(Math.sin(i / 50) * 300, i * 10));
  assert.doesNotThrow(() => simplify(points, 100));
});

// ---------------------------------------------------------------- エンコード
test("エンコード: Google の仕様例と一致する", () => {
  // 仕様書の例 (38.5,-120.2) (40.7,-120.95) (43.252,-126.453) → "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
  const encoded = encode([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  assert.strictEqual(encoded, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
});

test("エンコード: 往復して元に戻る", () => {
  const points = [pt(0, 0), pt(120, 300), pt(-80, 900)];
  const back = decode(encode(points));
  assert.strictEqual(back.length, points.length);
  for (let i = 0; i < points.length; i++) {
    assert.ok(distanceMeters(points[i], back[i]) < 1.5, `${i}番目がずれた`);
  }
});

// ---------------------------------------------------------------- 連結
function fragment(name, points, extra = {}) {
  return { prefecture: "群馬県", name, ref: "", highway: "secondary", osmId: String(Math.random()), points, ...extra };
}

test("連結: 端点が一致する断片が1本になる", () => {
  const a = fragment("県道1号", [pt(0, 0), pt(0, 500)]);
  const b = fragment("県道1号", [pt(0, 500), pt(0, 1000)]);
  const c = fragment("県道1号", [pt(0, 1000), pt(0, 1500)]);
  const chains = stitch([b, c, a]);   // 順番はバラバラでよい
  assert.strictEqual(chains.length, 1);
  assert.strictEqual(chains[0].fragmentCount, 3);
  assert.strictEqual(chains[0].points.length, 4, "重なった端点が1点に畳まれる");
});

test("連結: 向きが逆の断片も繋ぐ", () => {
  const a = fragment("県道1号", [pt(0, 0), pt(0, 500)]);
  const b = fragment("県道1号", [pt(0, 1000), pt(0, 500)]);   // 逆向き
  const chains = stitch([a, b]);
  assert.strictEqual(chains.length, 1);
  assert.strictEqual(chains[0].points.length, 3);
});

test("連結: 離れている断片は別の線になる", () => {
  const a = fragment("県道1号", [pt(0, 0), pt(0, 500)]);
  const b = fragment("県道1号", [pt(0, 50000), pt(0, 50500)]);
  assert.strictEqual(stitch([a, b]).length, 2);
});

test("連結: 名前が違えば繋がない", () => {
  const a = fragment("県道1号", [pt(0, 0), pt(0, 500)]);
  const b = fragment("県道2号", [pt(0, 500), pt(0, 1000)]);
  assert.strictEqual(stitch([a, b]).length, 2);
});

test("連結: 県が違えば繋がない（同名の別道路を混ぜない）", () => {
  const a = fragment("県道1号", [pt(0, 0), pt(0, 500)]);
  const b = fragment("県道1号", [pt(0, 500), pt(0, 1000)], { prefecture: "栃木県" });
  assert.strictEqual(stitch([a, b]).length, 2);
});

test("連結: 分岐では進行方向を保つ方を選ぶ", () => {
  const main = fragment("国道1号", [pt(0, 0), pt(0, 500)]);
  const straight = fragment("国道1号", [pt(0, 500), pt(0, 1000)]);      // まっすぐ
  const branch = fragment("国道1号", [pt(0, 500), pt(500, 500)]);       // 直角に逸れる
  const chains = stitch([main, straight, branch]);
  const longest = chains.sort((a, b) => b.points.length - a.points.length)[0];
  // まっすぐ側が本線として繋がる
  const hasStraight = longest.points.some((p) => distanceMeters(p, pt(0, 1000)) < 1);
  assert.ok(hasStraight, "直進側が本線にならなかった");
});

test("連結: 同じ断片が複数グリッドに現れても重複しない", () => {
  const points = [pt(0, 0), pt(0, 500)];
  const a = { prefecture: "群馬県", name: "県道1号", ref: "", highway: "secondary", osmId: "42", points };
  const b = { ...a, points: points.slice() };
  const chains = stitch([a, b]);
  assert.strictEqual(chains.length, 1);
  assert.strictEqual(chains[0].fragmentCount, 1);
});

test("連結: highway は長さで多数決", () => {
  const short = fragment("県道1号", [pt(0, 0), pt(0, 100)], { highway: "tertiary" });
  const long = fragment("県道1号", [pt(0, 100), pt(0, 5000)], { highway: "secondary" });
  assert.strictEqual(stitch([short, long])[0].highway, "secondary");
});

// ---------------------------------------------------------------- 区間の切り出し
/** 半径 radius の円弧。曲率のはっきりした「峠」を作る */
function arc(radiusM, sweepDeg, stepDeg = 2) {
  const points = [];
  for (let a = 0; a <= sweepDeg; a += stepDeg) {
    const r = (a * Math.PI) / 180;
    points.push(pt(radiusM * Math.sin(r), radiusM * (1 - Math.cos(r))));
  }
  return points;
}

test("切り出し: まっすぐな道からは何も出ない", () => {
  const straight = [];
  for (let i = 0; i <= 2000; i++) straight.push(pt(0, i * 10));   // 20km の直線
  assert.strictEqual(extract(straight).length, 0);
});

test("切り出し: 短い曲がりくねりは最小長に満たないので出ない", () => {
  const short = arc(300, 180, 5);   // 約1km
  assert.strictEqual(extract(short).length, 0);
});

test("切り出し: 曲がりくねった長い道は1区間として出る", () => {
  // つづら折り: 半径150mの180度カーブを繰り返して 6km ほど
  const points = [];
  let northOffset = 0;
  for (let k = 0; k < 12; k++) {
    for (let a = 0; a <= 180; a += 6) {
      const r = (a * Math.PI) / 180;
      const dir = k % 2 === 0 ? 1 : -1;
      points.push(pt(dir * 150 * Math.sin(r), northOffset + 150 * (1 - Math.cos(r))));
    }
    northOffset += 300;
  }
  const segments = extract(points);
  assert.strictEqual(segments.length, 1);
  assert.ok(segments[0].lengthMeters >= EXTRACT.minMeters);
  assert.ok(segments[0].curviness > 200, `曲率が低い: ${segments[0].curviness.toFixed(0)}`);
  assert.ok(segments[0].flow > 5, `flow が低い: ${segments[0].flow.toFixed(1)}`);
});

test("切り出し: 直線をはさんだ2つの峠は、間が長ければ別区間になる", () => {
  const build = (offset) => {
    const out = [];
    let north = offset;
    for (let k = 0; k < 10; k++) {
      for (let a = 0; a <= 180; a += 6) {
        const r = (a * Math.PI) / 180;
        const dir = k % 2 === 0 ? 1 : -1;
        out.push(pt(dir * 150 * Math.sin(r), north + 150 * (1 - Math.cos(r))));
      }
      north += 300;
    }
    return out;
  };
  const first = build(0);
  const gap = [];
  const gapStart = first[first.length - 1];
  for (let i = 1; i <= 500; i++) gap.push([gapStart[0], gapStart[1] + (i * 10) / M_PER_LAT]);  // 5km の直線
  const second = build(3000 + 5000);
  const segments = extract(first.concat(gap, second));
  assert.strictEqual(segments.length, 2, `区間数=${segments.length}`);
});

test("切り出し: 短い直線で切れているだけなら繋ぐ", () => {
  const build = (north0) => {
    const out = [];
    let north = north0;
    for (let k = 0; k < 8; k++) {
      for (let a = 0; a <= 180; a += 6) {
        const r = (a * Math.PI) / 180;
        const dir = k % 2 === 0 ? 1 : -1;
        out.push(pt(dir * 150 * Math.sin(r), north + 150 * (1 - Math.cos(r))));
      }
      north += 300;
    }
    return out;
  };
  const first = build(0);
  const gap = [];
  const gapStart = first[first.length - 1];
  for (let i = 1; i <= 40; i++) gap.push([gapStart[0], gapStart[1] + (i * 10) / M_PER_LAT]);   // 400m だけ
  const second = build(2400 + 400);
  const segments = extract(first.concat(gap, second));
  assert.strictEqual(segments.length, 1, "短い直線で分断されてしまった");
});

test("切り出し: 長すぎる区間は上限で切られる", () => {
  const points = [];
  let north = 0;
  for (let k = 0; k < 200; k++) {
    for (let a = 0; a <= 180; a += 6) {
      const r = (a * Math.PI) / 180;
      const dir = k % 2 === 0 ? 1 : -1;
      points.push(pt(dir * 150 * Math.sin(r), north + 150 * (1 - Math.cos(r))));
    }
    north += 300;
  }
  const segments = extract(points);
  assert.ok(segments.length >= 1);
  for (const s of segments) {
    assert.ok(s.lengthMeters <= EXTRACT.maxMeters + 200, `上限を超えた: ${s.lengthMeters}`);
  }
});

// ---------------------------------------------------------------- 点数
test("点数: 峠は市街地より高い（flow が効く）", () => {
  // 峠: 大きい角が緩やかに続く
  const pass = { lengthMeters: 12000, curviness: 220, flow: 16, turnCount: 165 };
  // 市街地: 同じ曲率でも小さい角が細かく続く
  const city = { lengthMeters: 12000, curviness: 220, flow: 4, turnCount: 660 };
  const passScore = score(pass, "secondary").score;
  const cityScore = score(city, "secondary").score;
  assert.ok(passScore > cityScore, `峠 ${passScore.toFixed(1)} ≦ 市街地 ${cityScore.toFixed(1)}`);
  assert.ok(passScore - cityScore > 10, `差が小さすぎる: ${(passScore - cityScore).toFixed(1)}`);
});

test("点数: 長い方が高い（同条件なら）", () => {
  const short = { lengthMeters: 3500, curviness: 200, flow: 12, turnCount: 50 };
  const long = { lengthMeters: 25000, curviness: 200, flow: 12, turnCount: 350 };
  assert.ok(score(long, "secondary").score > score(short, "secondary").score);
});

test("点数: 高速より県道級が高い", () => {
  const seg = { lengthMeters: 12000, curviness: 200, flow: 12, turnCount: 165 };
  assert.ok(score(seg, "secondary").score > score(seg, "motorway").score);
});

test("点数: 信号はすべて 0〜1 に収まる", () => {
  const extremes = [
    { lengthMeters: 1, curviness: 0, flow: 0, turnCount: 0 },
    { lengthMeters: 1e9, curviness: 1e9, flow: 1e9, turnCount: 1e9 },
    { lengthMeters: 0, curviness: NaN, flow: Infinity, turnCount: 0 },
  ];
  for (const seg of extremes) {
    for (const [key, value] of Object.entries(signals(seg, "secondary"))) {
      assert.ok(value >= 0 && value <= 1, `${key} が範囲外: ${value}`);
    }
  }
});

test("点数: 未知の highway でも落ちない", () => {
  const seg = { lengthMeters: 5000, curviness: 150, flow: 10, turnCount: 70 };
  const s = score(seg, "living_street").score;
  assert.ok(Number.isFinite(s) && s > 0);
});

test("点数: 0〜100 に収まる", () => {
  const seg = { lengthMeters: 1e6, curviness: 1e4, flow: 1e3, turnCount: 1e4 };
  const s = score(seg, "secondary").score;
  assert.ok(s >= 0 && s <= 100, `${s}`);
});

test("切り出し: 閾値を超える範囲が無くても落ちない", () => {
  const straight = [];
  for (let i = 0; i <= 500; i++) straight.push(pt(0, i * 20));
  assert.doesNotThrow(() => extract(straight));
  assert.strictEqual(extract(straight).length, 0);
});

test("切り出し: 点が少なくても落ちない", () => {
  assert.strictEqual(extract([]).length, 0);
  assert.strictEqual(extract([pt(0, 0)]).length, 0);
  assert.strictEqual(extract([pt(0, 0), pt(0, 10)]).length, 0);
});
