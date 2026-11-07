/**
 * admin/lib/devPlanAttach.js
 *
 * 調整ツールから開発者のプラン（users/{uid}/touringPlans）に場所を足す決めごと。
 * 利用者の要望（2026-11-07）:「未知のスポットで開発者のプランに追加できるようにしたい」。
 *
 * ⚠️ 足せるのは開発者 3X7lTlF7bTUOGkb5gWiiLol3a5W2 のプランだけ（利用者の指定 2026-11-07「3X7l…だけ」）。
 *    InternalUsers のもう一人（5elM…）や、ほかの人のプランには書かない
 * ⚠️ スポットの形はアプリの `TouringSpot.toDict()`（TouringPlanModel.swift）と同じにする。
 *    印（投稿の無い場所）は spotId なし・isCustomPin true、投稿は spotId あり・isCustomPin false
 * ⚠️ もう入っているかは、アプリの `PlanAttachmentManager.isInPlan` と同じく道を除いて 100m 以内で見る
 *    （印は足すたびに id が変わるので id では見ない）
 */
"use strict";

const { metersBetween } = require("./unknownSpots");

/** ⚠️ 利用者の指定でこの1人だけ。本人の許可なく足さない */
const DEV_UIDS = ["3X7lTlF7bTUOGkb5gWiiLol3a5W2"];
/** 開発者はサブスク扱いなので、アプリの TouringPlanLimits.subscribedSpotsPerPlan と同じ */
const MAX_SPOTS = 10;
const NEAR_METERS = 100;

const isDev = (uid) => DEV_UIDS.includes(String(uid || ""));

/** 足す場所を確かめて、アプリと同じ形の dict にする。おかしければ { error } */
function spotDict(input, order) {
  const name = String(input && input.name || "").trim();
  const lat = Number(input && input.lat), lng = Number(input && input.lng);
  if (!name) return { error: "名前が無い" };
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { error: "緯度経度がおかしい" };
  }
  const spotId = input.spotId ? String(input.spotId) : null;
  const dict = { name, lat, lng, isCustomPin: !spotId, order };
  if (spotId) dict.spotId = spotId;
  if (input.address) dict.address = String(input.address);
  if (input.imageUrl) dict.imageUrl = String(input.imageUrl);
  return { dict };
}

const isRoad = (s) => s && s.isRoad === true && Array.isArray(s.path) && s.path.length >= 2;

/** そのプランの 100m 以内に入っている場所（道は見ない）。無ければ null */
function nearIn(spots, lat, lng) {
  return (spots || []).find((s) => !isRoad(s) && Number.isFinite(s.lat) && Number.isFinite(s.lng)
    && metersBetween(lat, lng, s.lat, s.lng) <= NEAR_METERS) || null;
}

/** 足せるか。足せれば { spots: 足したあとの配列 }、足せなければ { error, code } */
function appended(spots, input) {
  const list = Array.isArray(spots) ? spots : [];
  const made = spotDict(input, list.length);
  if (made.error) return { error: made.error, code: 400 };
  const near = nearIn(list, made.dict.lat, made.dict.lng);
  if (near) return { error: `もう入っています（${near.name || "名前なし"}）`, code: 409 };
  if (list.length >= MAX_SPOTS) return { error: `このプランは ${MAX_SPOTS} 件までです`, code: 409 };
  return { spots: [...list, made.dict], spot: made.dict };
}

module.exports = { DEV_UIDS, MAX_SPOTS, NEAR_METERS, isDev, spotDict, nearIn, appended };
