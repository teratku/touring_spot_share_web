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
 * ⚠️ Hosting の書き換え（`/v1/web/**`・`/blog/blog-detail.html`・`/s/` `/u/` `/r/`・`/sitemap.xml`）は無い。
 *    それを使うページ（Web のルート作成・ブログの詳細・共有リンク）は 4317 では動かない
 */
const express = require("express");

const HOSTING_ORIGIN = "https://biketeilen.web.app";

/** 予約 URL の転送先（純関数・テスト対象）。知らない形は null（どこへも回さない） */
function firebaseReservedTarget(urlPath) {
  if (urlPath === "/__/firebase/init.js") return HOSTING_ORIGIN + urlPath;
  if (/^\/__\/firebase\/\d+\.\d+\.\d+\/firebase-[a-z-]+\.js$/.test(urlPath)) return HOSTING_ORIGIN + urlPath;
  return null;
}

/** 公開サイトを付ける。⚠️ 管理ツールの画面と窓口をすべて付けたあとに呼ぶこと */
function mountPublicSite(app, publicDir) {
  app.get(/^\/__\/firebase\//, (req, res) => {
    const target = firebaseReservedTarget(req.path);
    if (!target) return res.status(404).send("見つかりません: " + req.path);
    res.redirect(302, target);
  });
  app.use(express.static(publicDir));
}

module.exports = { HOSTING_ORIGIN, firebaseReservedTarget, mountPublicSite };
