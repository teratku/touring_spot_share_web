"use strict";
/**
 * publicSite.js — 管理ツール（127.0.0.1:4317）で公開サイト（../public）も開けるようにする。
 *
 * ⚠️ 利用者の要望（2026-10-11）: 5002（firebase serve／エミュレーター）で動かしていた Web を 4317 で動かしたい
 *    （例: http://127.0.0.1:4317/conquest/conquest.html）。
 * ⚠️ **管理ツールの画面と窓口が先。** 公開サイトは、管理ツールに無いパスだけを受ける
 *    （server.js の最後、`app.listen` の直前に付けること）。`/` は管理ツール（ラリービルダー）のまま。
 *    公開サイトのトップは `/index.html`
 * ⚠️ **Firebase の予約 URL（`/__/firebase/…`）は本番のホスティングへ回す。** 5002 では firebase-tools が
 *    SDK と初期化（init.js）を出していた。その init.js は `?useEmulator=true` を付けない限りエミュレーターに
 *    繋がない（本番の Firestore・ログインを使う）ので、本番のものと中身が同じ。
 *    設定（apiKey など）をここに写さないこと（写すと、差し替えたときにここだけ古いまま残る）
 * ⚠️ **Web の窓口（`/v1/web/**`）は本番のホスティングへ転送する**（ホスティングが経路サーバ route-api へ書き換える）。
 *    利用者の報告（2026-10-15）: 4317 の Web のルート作成で「経路を作れませんでした（404）」。転送が無かった。
 *    ログインの証（Authorization）と体をそのまま渡すので、本番のページと同じくサーバがサブスクを確かめる。
 *    ⚠️ 本番の経路サーバを使う（手元の Valhalla ではない）。route-api の新しい版を試すときは配信してから
 * ⚠️ ほかの Hosting の書き換え（`/blog/blog-detail.html`・`/s/` `/u/` `/r/`・`/sitemap.xml`）は無い。
 *    それを使うページ（ブログの詳細・共有リンク）は 4317 では動かない
 */
const express = require("express");

const HOSTING_ORIGIN = "https://biketeilen.web.app";

/** 予約 URL の転送先（純関数・テスト対象）。知らない形は null（どこへも回さない） */
function firebaseReservedTarget(urlPath) {
  if (urlPath === "/__/firebase/init.js") return HOSTING_ORIGIN + urlPath;
  if (/^\/__\/firebase\/\d+\.\d+\.\d+\/firebase-[a-z-]+\.js$/.test(urlPath)) return HOSTING_ORIGIN + urlPath;
  return null;
}

/** Web の窓口の転送先（純関数・テスト対象）。`/v1/web/<名前>` だけ。知らない形は null */
function webApiTarget(urlPath, origin) {
  return /^\/v1\/web\/[a-z][a-z-]*$/.test(urlPath) ? (origin || HOSTING_ORIGIN) + urlPath : null;
}

/**
 * 公開サイトを付ける。⚠️ 管理ツールの画面と窓口をすべて付けたあとに呼ぶこと。
 * `options.webApiOrigin` は Web の窓口の転送先（テスト用。既定は本番のホスティング）
 */
function mountPublicSite(app, publicDir, options) {
  const webApiOrigin = (options && options.webApiOrigin) || HOSTING_ORIGIN;
  app.post(/^\/v1\/web\//, express.json({ limit: "8mb" }), async (req, res) => {
    const target = webApiTarget(req.path, webApiOrigin);
    if (!target) return res.status(404).json({ error: "見つかりません: " + req.path });
    try {
      const headers = { "Content-Type": "application/json" };
      if (req.get("authorization")) headers.Authorization = req.get("authorization");
      const upstream = await fetch(target, { method: "POST", headers, body: JSON.stringify(req.body || {}) });
      res.status(upstream.status).type(upstream.headers.get("content-type") || "application/json").send(await upstream.text());
    } catch (e) {
      res.status(502).json({ error: "経路サーバへ転送できませんでした: " + e.message });
    }
  });
  app.get(/^\/__\/firebase\//, (req, res) => {
    const target = firebaseReservedTarget(req.path);
    if (!target) return res.status(404).send("見つかりません: " + req.path);
    res.redirect(302, target);
  });
  app.use(express.static(publicDir));
}

module.exports = { HOSTING_ORIGIN, firebaseReservedTarget, webApiTarget, mountPublicSite };
