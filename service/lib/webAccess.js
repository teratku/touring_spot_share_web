"use strict";

/**
 * Web からのルート作成はサブスク（Plus・Pro・3日間コース）の人だけ。
 *
 * ⚠️ 利用者の判断（2026-10-08）:「web でルート生成できるようにしたい（サブスク限定）。生成したルートをアプリ側で連携」。
 *    範囲は「プランから作って保存 → アプリで開く」。**経路サーバでもサブスクを確かめる**（画面だけで隠しても、
 *    窓口を直接たたけば使えてしまう）。
 * ⚠️ アプリが使う `/v1/route` には掛けない（無料の人もアプリでルートを作れる。今まで通り）。
 * ⚠️ 加入の状態はアプリ（SubscriptionStateManager）が `subscriptions/{uid}` に書いている。
 *    規則（firestore.rules の isValidSubscriptionWrite）で tier と isSubscribed は揃っている
 */

const PAID_TIERS = ["plus", "pro"];

/**
 * 加入の記録が無くてもサブスク（Pro）として扱う人の UID。
 * ⚠️ **アプリの `InternalUsers.userIDs`（touringSpotShare/saveRoute/nav/InternalUsers.swift）と同じにすること。**
 *    利用者の要望（2026-10-16）:「アプリの特定の uid だけフルを使用できるようにしているが、同じように web もしたい」。
 *    画面側（public/subscription.js の INTERNAL_USER_IDS）とも同じ（service/test/webAccess.test.js が突き合わせる）
 * ⚠️ **本人の許可なく他人の UID を足さないこと。** 判定を「空なら全員」のように緩めないこと
 */
const INTERNAL_USER_IDS = new Set([
  "5elMKe1WEMPVP3LezAuoMwJbJE32",
  "3X7lTlF7bTUOGkb5gWiiLol3a5W2",
]);

function isInternalUser(uid) { return typeof uid === "string" && INTERNAL_USER_IDS.has(uid); }

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

/** 加入中か（加入の印・有料の段・期限があれば期限内） */
function isActiveSubscription(data, now = new Date()) {
  if (!data || data.isSubscribed !== true || !PAID_TIERS.includes(data.tier)) return false;
  const expiration = toDate(data.expiration);
  return !expiration || expiration > now;
}

/** 認証（requireAuth）のあとに置く。加入していなければ 403 */
function makeRequireSubscription(db, { now = () => new Date() } = {}) {
  return async function requireSubscription(req, res, next) {
    try {
      // ⚠️ 特定の UID はアプリと同じく加入の記録が無くても通す
      if (isInternalUser(req.user && req.user.uid)) return next();
      const snap = await db.collection("subscriptions").doc(req.user.uid).get();
      if (!isActiveSubscription(snap.exists ? snap.data() : null, now())) {
        return res.status(403).json({ error: "Web でのルート作成は、サブスク（Plus・Pro）の方だけ使えます" });
      }
      next();
    } catch (e) {
      res.status(500).json({ error: "サブスクの状態を確かめられません" });
    }
  };
}

module.exports = { isActiveSubscription, makeRequireSubscription, PAID_TIERS, INTERNAL_USER_IDS, isInternalUser };
