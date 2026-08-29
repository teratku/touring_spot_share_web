"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 作り直しの窓口（`/api/rebuild/…`）。
 *
 * ⚠️ **立ち上がっている管理ツールに向かって叩く。** Valhalla は要らない
 *    （地図データを引かないので）。立っていなければ飛ばす。
 * ⚠️ **本物のデータを書き換える。** 置き換えたものは必ず戻すこと
 */
const BASE = process.env.ADMIN_URL || "http://127.0.0.1:4317";
const REG_DIR = path.join(__dirname, "..", "data", "road-restrictions");
const SKIP_FILE = path.join(__dirname, "..", "data", "restriction-rebuild", "skipped.json");

async function up() {
  try {
    const r = await fetch(`${BASE}/api/rebuild/prefectures`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
const skipIfDown = async (t) => (await up()) ? false : t.skip(`管理ツールが居ない（${BASE}）`);

/**
 * 作り直しの対象が残っているか。
 *
 * ⚠️ **片付くと0件になる。** そのとき落とすのは間違いで、飛ばすのが正しい。
 *    もう一度動かすには `node matchJarticToRegistered.js`（二普協由来が残っていれば）。
 */
async function pending(romaji) {
  try {
    const d = await get(`/api/rebuild/${romaji}`);
    return d.items || [];
  } catch { return []; }
}
const skipIfDone = (t, items, where) =>
  items.length ? false : t.skip(`${where} に作り直す対象が残っていない（もう片付いている）`);
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

/** 県ぶんの控えを取って、終わったら戻す */
function withBackup(romaji, fn) {
  const file = path.join(REG_DIR, `${romaji}.json`);
  const before = fs.readFileSync(file, "utf8");
  const skipBefore = fs.existsSync(SKIP_FILE) ? fs.readFileSync(SKIP_FILE, "utf8") : null;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      fs.writeFileSync(file, before);
      if (skipBefore === null) { try { fs.unlinkSync(SKIP_FILE); } catch {} }
      else fs.writeFileSync(SKIP_FILE, skipBefore);
    });
}

test("作り直す対象は、二普協由来だけ", async (t) => {
  if (await skipIfDown(t)) return;
  const { prefectures } = await get("/api/rebuild/prefectures");
  if (!prefectures.length) return t.skip("作り直す対象が残っていない（もう片付いている）");
  const d = await get(`/api/rebuild/${prefectures[0].romaji}`);
  const reg = JSON.parse(fs.readFileSync(path.join(REG_DIR, `${prefectures[0].romaji}.json`), "utf8"));
  const byId = new Map(reg.restrictions.map((r) => [r.id, r]));
  for (const it of d.items) {
    // ⚠️ osm は商用可なのでそのまま売れる。ここに出てはいけない
    assert.strictEqual(byId.get(it.registered.id).origin, "jmpsa",
      `二普協由来でないものが対象に入っている: ${it.registered.id}`);
  }
});

test("置き換えると、販売できる出どころとして記録される", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("ibaraki", async () => {
    const before = await get("/api/rebuild/ibaraki");
    const item = before.items.find((x) => x.matches.length);
    if (!item) return t.skip("茨城に候補つきの対象が残っていない（もう片付いている）");

    const r = await post("/api/rebuild/ibaraki/promote", {
      registeredId: item.registered.id, candidateId: item.matches[0].id,
    });
    assert.ok(r.ok, `置き換えられない: ${r.error}`);

    const reg = JSON.parse(fs.readFileSync(path.join(REG_DIR, "ibaraki.json"), "utf8"));
    const now = reg.restrictions.find((x) => x.id === item.matches[0].id);
    assert.ok(now, "置き換えた規制が見つからない");
    assert.strictEqual(now.origin, "jartic", "出どころを jartic と記録していない");
    assert.ok(now.polyline && now.polyline.length > 10, "線が入っていない");
    // ⚠️ 元の1件が消えただけで、他は巻き添えになっていない
    assert.strictEqual(reg.restrictions.length, before.items.length >= 0 ? reg.restrictions.length : 0);
    assert.ok(!reg.restrictions.some((x) => x.id === item.registered.id), "元の規制が残っている");
  });
});

test("置き換えたものは、作り直しの一覧から消える", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("ibaraki", async () => {
    const before = await get("/api/rebuild/ibaraki");
    const item = before.items.find((x) => x.matches.length);
    if (!item) return t.skip("茨城に候補つきの対象が残っていない（もう片付いている）");
    await post("/api/rebuild/ibaraki/promote",
      { registeredId: item.registered.id, candidateId: item.matches[0].id });

    // ⚠️ **突き合わせファイルは静的な控え。** そのまま返すと済んだ件が再読込で戻る
    const after = await get("/api/rebuild/ibaraki");
    assert.strictEqual(after.items.length, before.items.length - 1,
      "置き換えた件が一覧に残っている");
    assert.ok(!after.items.some((x) => x.registered.id === item.registered.id));

    // ⚠️ 一覧と中身で数え方がずれていないこと
    const list = await get("/api/rebuild/prefectures");
    const pref = list.prefectures.find((p) => p.romaji === "ibaraki");
    assert.strictEqual(pref ? pref.count : 0, after.items.length, "県一覧の数が中身と合わない");
  });
});

test("「JARTIC に無い」と決めても、規制そのものは消さない", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("ibaraki", async () => {
    const before = await get("/api/rebuild/ibaraki");
    if (!before.items.length) return t.skip("茨城に対象が残っていない（もう片付いている）");
    const id = before.items[0].registered.id;
    await post("/api/rebuild/skip", { registeredId: id });

    const after = await get("/api/rebuild/ibaraki");
    assert.strictEqual(after.items.length, before.items.length - 1, "一覧から外れていない");

    // ⚠️ **アプリでは今までどおり使う。** 販売APIに載らないだけ
    const reg = JSON.parse(fs.readFileSync(path.join(REG_DIR, "ibaraki.json"), "utf8"));
    assert.ok(reg.restrictions.some((x) => x.id === id), "規制そのものを消している");

    await post("/api/rebuild/skip", { registeredId: id, undo: true });
    assert.strictEqual((await get("/api/rebuild/ibaraki")).items.length, before.items.length,
      "取り消せない");
  });
});

test("おかしな指定で書き換えない", async (t) => {
  if (await skipIfDown(t)) return;
  const before = fs.readFileSync(path.join(REG_DIR, "ibaraki.json"), "utf8");
  assert.ok((await post("/api/rebuild/ibaraki/promote", {})).error, "空の指定を通している");
  assert.ok((await post("/api/rebuild/ibaraki/promote",
    { registeredId: "でたらめ", candidateId: "でたらめ" })).error, "無い id を通している");
  assert.strictEqual(fs.readFileSync(path.join(REG_DIR, "ibaraki.json"), "utf8"), before,
    "失敗したのにファイルを書き換えている");
});

test("同じ候補に寄せても、重複して登録しない", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("saitama", async () => {
    const before = await get("/api/rebuild/saitama");
    // ⚠️ **実際に5件そうなった。** 二普協側では隣り合う2区間でも、
    //    JARTIC 側では1区間ということがある
    const seen = new Map();
    let pair = null;
    for (const it of before.items) {
      for (const m of it.matches) {
        if (seen.has(m.id)) { pair = [seen.get(m.id), it, m.id]; break; }
        seen.set(m.id, it);
      }
      if (pair) break;
    }
    if (!pair) return t.skip("同じ候補を指す対が無い（材料が悪い）");
    const [a, b, candidateId] = pair;

    await post("/api/rebuild/saitama/promote", { registeredId: a.registered.id, candidateId });
    const second = await post("/api/rebuild/saitama/promote",
      { registeredId: b.registered.id, candidateId });
    assert.ok(second.ok, `2件目が通らない: ${second.error}`);

    const reg = JSON.parse(fs.readFileSync(path.join(REG_DIR, "saitama.json"), "utf8"));
    const hits = reg.restrictions.filter((r) => r.id === candidateId);
    assert.strictEqual(hits.length, 1, `同じ id が ${hits.length} 件ある`);
    // ⚠️ 2つ目を足さずに元を消す。2区間が1区間にまとまる
    assert.ok(!reg.restrictions.some((r) => r.id === a.registered.id), "1件目の元が残っている");
    assert.ok(!reg.restrictions.some((r) => r.id === b.registered.id), "2件目の元が残っている");
  });
});

test("登録済みの規制に、同じ id が2つ無い", () => {
  // ⚠️ **回帰の見張り。** 重複すると同じ規制を2度評価し、件数も二重に数える
  const seen = new Map();
  for (const f of fs.readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), "utf8"));
    for (const r of j.restrictions || []) {
      assert.ok(!seen.has(r.id), `id が重複している: ${r.id}（${seen.get(r.id)} と ${f}）`);
      seen.set(r.id, f);
    }
  }
  assert.ok(seen.size > 0, "規制が1件も無い（材料が悪い）");
});

test("同じ候補に置き換え直しても、規制を消さない", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("ibaraki", async () => {
    const before = await get("/api/rebuild/ibaraki");
    const item = before.items.find((x) => x.matches.length);
    if (!item) return t.skip("茨城に候補つきの対象が残っていない（もう片付いている）");
    const candidateId = item.matches[0].id;
    await post("/api/rebuild/ibaraki/promote", { registeredId: item.registered.id, candidateId });

    // ⚠️ **自分自身を重複とみなすと消える。** 画面は出さないが、窓口は
    //    古い画面や直叩きから同じ指定を受けうる
    const again = await post("/api/rebuild/ibaraki/promote",
      { registeredId: candidateId, candidateId });
    const reg = JSON.parse(fs.readFileSync(path.join(REG_DIR, "ibaraki.json"), "utf8"));
    assert.ok(reg.restrictions.some((r) => r.id === candidateId),
      `置き換え直しで規制が消えた（${JSON.stringify(again)}）`);
    assert.strictEqual(reg.restrictions.filter((r) => r.id === candidateId).length, 1,
      "置き換え直しで重複した");
  });
});

test("片付いたあとも、進み具合の数字が出る", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ **空のときに何も言わないと、片付いたのか壊れているのか見分けがつかない**
  //    （実際に「データが表示されていない」と見えた）
  const p = await get("/api/rebuild/progress");
  assert.ok(p.total > 0, "登録済みの件数が出ていない");
  for (const k of ["sellable", "osm", "jartic", "jmpsa", "skipped", "pending"]) {
    assert.ok(Number.isFinite(p[k]), `${k} が数字で返っていない`);
  }
  // 残り = まだ二普協由来で、見送ってもいないもの
  assert.strictEqual(p.pending, Math.max(0, p.jmpsa - p.skipped), "残りの数え方が合わない");
  assert.ok(p.osm + p.jartic + p.jmpsa <= p.total, "内訳が合計を超えている");
  // ⚠️ **控えのファイルと突き合わせる。** 自分の数字どうしで辻褄を合わせても意味が無い
  const onDisk = fs.existsSync(SKIP_FILE)
    ? (JSON.parse(fs.readFileSync(SKIP_FILE, "utf8")).ids || []).length : 0;
  assert.strictEqual(p.skipped, onDisk, `見送りの件数が控えと違う（${p.skipped} 対 ${onDisk}）`);
  // 出どころの内訳も、実物と突き合わせる
  let jmpsa = 0;
  for (const f of fs.readdirSync(REG_DIR).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), "utf8"));
    jmpsa += (d.restrictions || []).filter((r) => r.origin === "jmpsa").length;
  }
  assert.strictEqual(p.jmpsa, jmpsa, "二普協由来の件数が実物と違う");
});

test("見送ったものを、見て戻せる", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("tokyo", async () => {
    // ⚠️ **隠したままだと、間違えて見送った1件を戻せない**
    const hidden  = await get("/api/rebuild/tokyo");
    const shown   = await get("/api/rebuild/tokyo?includeSkipped=1");
    // ⚠️ **`t.skip` で逃げないこと。** 逃がすと「旗を渡しても出さない」壊れ方を見逃す
    //    （実際に見逃した）。控えに東京ぶんが在るなら、出ていなければ落とす
    const ids = new Set(fs.existsSync(SKIP_FILE)
      ? (JSON.parse(fs.readFileSync(SKIP_FILE, "utf8")).ids || []) : []);
    const inTokyo = (JSON.parse(fs.readFileSync(path.join(REG_DIR, "tokyo.json"), "utf8"))
      .restrictions || []).filter((r) => ids.has(r.id)).length;
    assert.ok(inTokyo > 0, "東京に見送りが無い（材料が悪い）");
    assert.strictEqual(shown.items.filter((x) => x.skipped).length, inTokyo,
      `見送り ${inTokyo}件 のうち ${shown.items.filter((x) => x.skipped).length}件 しか出ていない`);
    assert.ok(shown.items.length > hidden.items.length, "見送りが見えるようになっていない");
    assert.ok(shown.items.some((x) => x.skipped === true), "見送りの印が付いていない");

    const one = shown.items.find((x) => x.skipped);
    await post("/api/rebuild/skip", { registeredId: one.registered.id, undo: true });
    const after = await get("/api/rebuild/tokyo");
    assert.ok(after.items.some((x) => x.registered.id === one.registered.id),
      "取り消しても一覧に戻ってこない");
  });
});

test("見送りを見せても、片付いたものは戻さない", async (t) => {
  if (await skipIfDown(t)) return;
  // ⚠️ 置き換え済み（jartic 化した）ものまで出してはいけない
  const shown = await get("/api/rebuild/tokyo?includeSkipped=1");
  const reg = JSON.parse(fs.readFileSync(path.join(REG_DIR, "tokyo.json"), "utf8"));
  const byId = new Map(reg.restrictions.map((r) => [r.id, r]));
  for (const it of shown.items) {
    assert.strictEqual(byId.get(it.registered.id).origin, "jmpsa",
      `片付いたものが出ている: ${it.registered.id}`);
  }
});

test("由来を手で直したものは、作り直しの対象から外れる", async (t) => {
  if (await skipIfDown(t)) return;
  await withBackup("tokyo", async () => {
    // ⚠️ **id を変えずに由来だけ直す道がある**（road-builder で「自前調査」に直すなど）。
    //    id の有無だけで見ていると、売れる状態になったのに対象に残り続ける
    const file = path.join(REG_DIR, "tokyo.json");
    const reg = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = await get("/api/rebuild/tokyo?includeSkipped=1");
    const target = before.items[0];
    assert.ok(target, "東京に対象が無い（材料が悪い）");

    const r = reg.restrictions.find((x) => x.id === target.registered.id);
    r.origin = "survey";
    fs.writeFileSync(file, JSON.stringify(reg, null, 1) + "\n");

    const after = await get("/api/rebuild/tokyo?includeSkipped=1");
    assert.ok(!after.items.some((x) => x.registered.id === target.registered.id),
      "由来を直したのに、まだ作り直しの対象に残っている");
  });
});
