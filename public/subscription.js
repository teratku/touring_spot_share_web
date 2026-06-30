/*
 * subscription.js — 公開Web用：ログイン中ユーザー自身の購読状態を判定して機能ゲートに使う。
 *
 * 前提: ページで Firebase（compat）を初期化済みで、ユーザーがログインしていること。
 *       購読状態は iOS が subscriptions/{uid} に保存（本人のみ read）。
 *
 * 使い方:
 *   <script src="/subscription.js" defer></script>
 *   TSSSubscription.onReady(function (s) {
 *     if (s.isSubscribed) { // Pro限定機能を表示 } else { // 無料/未ログイン }
 *   });
 *
 * ※ クライアント側ゲートは「UIの出し分け」用。改ざん不可の本当の制限が要るなら
 *    Cloud Functions 等のサーバ側検証を併用すること。
 */
window.TSSSubscription = (function () {
  let cache = null;
  let inflight = null;

  function empty(extra) {
    return Object.assign(
      { loggedIn: false, isSubscribed: false, tier: "free", expiration: null, expired: false, noData: false },
      extra || {}
    );
  }

  /** 現在ログイン中ユーザーの購読状態を取得（subscriptions/{uid} を本人が読む）。 */
  async function forCurrentUser(force) {
    if (cache && !force) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (typeof firebase === "undefined" || !firebase.auth) return empty({ error: "firebase未初期化" });
        const user = firebase.auth().currentUser;
        if (!user) return empty({ loggedIn: false });
        const doc = await firebase.firestore().collection("subscriptions").doc(user.uid).get();
        if (!doc.exists) {
          cache = empty({ loggedIn: true, noData: true });
          return cache;
        }
        const d = doc.data() || {};
        const expDate = d.expiration && typeof d.expiration.toDate === "function" ? d.expiration.toDate() : null;
        const expired = !!(expDate && expDate < new Date());
        cache = {
          loggedIn: true,
          isSubscribed: d.isSubscribed === true && !expired,
          tier: d.tier || "free",
          expiration: expDate,
          expired: expired,
          noData: false,
          updatedAt: d.updatedAt && typeof d.updatedAt.toDate === "function" ? d.updatedAt.toDate() : null,
        };
        return cache;
      } catch (e) {
        console.error("[TSSSubscription]", e);
        const loggedIn = !!(typeof firebase !== "undefined" && firebase.auth && firebase.auth().currentUser);
        return empty({ loggedIn: loggedIn, error: e.message });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** 認証確定後にコールバックへ購読状態を渡す（onAuthStateChanged を内包）。 */
  function onReady(callback) {
    if (typeof firebase === "undefined" || !firebase.auth) {
      callback(empty());
      return;
    }
    firebase.auth().onAuthStateChanged(async function () {
      cache = null;
      callback(await forCurrentUser(true));
    });
  }

  /** Pro 判定の簡易ヘルパー。コールバックに (ok, status) を渡す。 */
  async function requirePro(onResult) {
    const st = await forCurrentUser();
    if (typeof onResult === "function") onResult(st.isSubscribed, st);
    return st.isSubscribed;
  }

  return { forCurrentUser: forCurrentUser, onReady: onReady, requirePro: requirePro };
})();
