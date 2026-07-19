const functions = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

const blogDetailHtml = fs.readFileSync(
  path.join(__dirname, "blog-detail-template.html"),
  "utf8"
);

exports.blogSSR = functions.https.onRequest(async (req, res) => {
  const postId = req.query.id;

  if (!postId) {
    res.redirect("/blog/blog.html");
    return;
  }

  try {
    const doc = await db.collection("blog_posts").doc(postId).get();

    if (!doc.exists) {
      res.status(404).send("<h1>記事が見つかりません</h1>");
      return;
    }

    const post = doc.data();
    const title = escapeHtml(post.title || "ツーリングスポットシェア ブログ");
    const description = escapeHtml(
      (post.content || "").replace(/[#*`\n]/g, "").substring(0, 160)
    );
    const image = post.thumbnailUrl || "https://biketeilen.web.app/img/og-default.png";
    const url = "https://biketeilen.web.app/blog/blog-detail.html?id=" + postId;

    const metaTags = [
      "<title>" + title + " | ツーリングスポットシェア</title>",
      '<meta name="description" content="' + description + '">',
      '<meta property="og:title" content="' + title + '">',
      '<meta property="og:description" content="' + description + '">',
      '<meta property="og:image" content="' + image + '">',
      '<meta property="og:url" content="' + url + '">',
      '<meta property="og:type" content="article">',
      '<meta property="og:site_name" content="ツーリングスポットシェア">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="' + title + '">',
      '<meta name="twitter:description" content="' + description + '">',
      '<meta name="twitter:image" content="' + image + '">'
    ].join("\n    ");

    const noscriptBlock =
      "<noscript><article><h1>" +
      title +
      "</h1><p>" +
      description +
      "</p></article></noscript>";

    let html = blogDetailHtml;
    html = html.replace("<!-- SSR_META -->", metaTags);
    html = html.replace("<!-- SSR_NOSCRIPT -->", noscriptBlock);

    res.set("Cache-Control", "public, max-age=600, s-maxage=1200");
    res.status(200).send(html);
  } catch (error) {
    console.error("blogSSR error:", error);
    res.status(500).send("<h1>エラーが発生しました</h1>");
  }
});

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ===== 共有用 動的OGP =====
// /s/:id（スポット）・/u/:id（ユーザー）。クローラは実データのOGを読み、人は本ページへ即リダイレクト。
function shareHtml(o) {
  const t = escapeHtml(o.title || "ツーリングスポットシェア");
  const d = escapeHtml(o.description || "");
  const img = o.image || "https://biketeilen.web.app/images/ogp.png";
  return [
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">',
    "<title>" + t + " | ツーリングスポットシェア</title>",
    '<meta name="description" content="' + d + '">',
    '<meta property="og:title" content="' + t + '">',
    '<meta property="og:description" content="' + d + '">',
    '<meta property="og:image" content="' + img + '">',
    '<meta property="og:url" content="' + o.url + '">',
    '<meta property="og:type" content="' + (o.type || "website") + '">',
    '<meta property="og:site_name" content="ツーリングスポットシェア">',
    '<meta property="og:locale" content="ja_JP">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + t + '">',
    '<meta name="twitter:image" content="' + img + '">',
    '<meta name="apple-itunes-app" content="app-id=1466607921">',
    '<link rel="canonical" href="' + o.url + '">',
    '<meta http-equiv="refresh" content="0; url=' + o.url + '">',
    "</head><body>",
    "<script>location.replace(" + JSON.stringify(o.url) + ");</script>",
    '<p><a href="' + o.url + '">ページへ移動</a></p>',
    "</body></html>",
  ].join("\n");
}

function pathId(req) {
  const seg = (req.path || "").split("/").filter(Boolean);
  return seg.length ? decodeURIComponent(seg[seg.length - 1]) : (req.query.id || "");
}

// UTMパラメータをリダイレクト先URLにも引き継ぐ（着地ページ側でも計測できるように）。
function withUtmParams(req, baseUrl) {
  const utmKeys = ["utm_source", "utm_medium", "utm_campaign"];
  const params = utmKeys
    .filter((k) => req.query[k])
    .map((k) => k + "=" + encodeURIComponent(req.query[k]))
    .join("&");
  return params ? baseUrl + "&" + params : baseUrl;
}

// ===== 共有リンクのUTM/クリック計測（成長施策 2.3） =====
// share.js が付与した utm_source/utm_medium/utm_campaign を読み取り、対象ドキュメントの
// shareClickCount をインクリメント＋構造化ログに出力する。レスポンスをブロックしないよう
// await せずファイア&フォーゲットで呼ぶ。
function logShareClick(req, collection, id) {
  if (!id) return;
  const utmSource = req.query.utm_source || "direct";
  const utmMedium = req.query.utm_medium || "";
  const utmCampaign = req.query.utm_campaign || "";

  console.log(
    `share_click collection=${collection} id=${id} utm_source=${utmSource} utm_medium=${utmMedium} utm_campaign=${utmCampaign}`
  );

  db.collection(collection).doc(id).update({
    shareClickCount: admin.firestore.FieldValue.increment(1),
  }).catch((err) => {
    console.warn(`shareClickCount更新失敗 collection=${collection} id=${id}:`, err);
  });
}

exports.spotShare = functions.https.onRequest(async (req, res) => {
  const id = pathId(req);
  const real = withUtmParams(req, "https://biketeilen.web.app/detail.html?id=" + encodeURIComponent(id));
  try {
    let title = "ツーリングスポット";
    let image = "https://biketeilen.web.app/images/ogp.png";
    let desc = "バイクで行きたいツーリングスポット｜ツーリングスポットシェア";
    if (id) {
      logShareClick(req, "imagedownload", id);
      const doc = await db.collection("imagedownload").doc(id).get();
      if (doc.exists) {
        const x = doc.data() || {};
        title = x.location_name || x.locality || x.administrative || title;
        image = (Array.isArray(x.locationImageURLs) && x.locationImageURLs[0]) || x.iconImageURL || image;
        const area = x.administrative || x.locality || "";
        desc = (area ? area + "の" : "") + "ツーリングスポット｜ツーリングスポットシェア";
      }
    }
    res.set("Cache-Control", "public, max-age=600, s-maxage=1200");
    res.status(200).send(shareHtml({ title, description: desc, image, url: real, type: "article" }));
  } catch (e) {
    console.error("spotShare error:", e);
    res.redirect(real);
  }
});

exports.userShare = functions.https.onRequest(async (req, res) => {
  const id = pathId(req);
  const real = withUtmParams(req, "https://biketeilen.web.app/user.html?id=" + encodeURIComponent(id));
  try {
    let title = "ユーザー";
    let image = "https://biketeilen.web.app/images/ogp.png";
    let desc = "投稿スポット・ルート・スタンプラリー｜ツーリングスポットシェア";
    if (id) {
      logShareClick(req, "userInfo", id);
      const doc = await db.collection("userInfo").doc(id).get();
      if (doc.exists) {
        const x = doc.data() || {};
        title = x.userName || title;
        image = x.userIcon || image;
        desc = (x.userName ? x.userName + "さんの" : "") + "投稿スポット・ルート・スタンプラリー｜ツーリングスポットシェア";
      }
    }
    res.set("Cache-Control", "public, max-age=600, s-maxage=1200");
    res.status(200).send(shareHtml({ title, description: desc, image, url: real, type: "profile" }));
  } catch (e) {
    console.error("userShare error:", e);
    res.redirect(real);
  }
});

exports.routeShare = functions.https.onRequest(async (req, res) => {
  const id = pathId(req);
  const real = withUtmParams(req, "https://biketeilen.web.app/route-detail.html?id=" + encodeURIComponent(id));
  try {
    let title = "ツーリングルート";
    let image = "https://biketeilen.web.app/images/ogp.png";
    let desc = "バイクツーリングのルート｜ツーリングスポットシェア";
    if (id) {
      logShareClick(req, "shared_routes", id);
      const doc = await db.collection("shared_routes").doc(id).get();
      if (doc.exists) {
        const x = doc.data() || {};
        title = x.title || title;
        image = x.coverImageUrl || image;
        const km = typeof x.distance === "number" ? x.distance.toFixed(1) + "km" : "";
        desc = (km ? km + "の" : "") + "ツーリングルート｜ツーリングスポットシェア";
      }
    }
    res.set("Cache-Control", "public, max-age=600, s-maxage=1200");
    res.status(200).send(shareHtml({ title, description: desc, image, url: real, type: "article" }));
  } catch (e) {
    console.error("routeShare error:", e);
    res.redirect(real);
  }
});

// ===== 動的サイトマップ =====
// 静的ページ＋公開コンテンツ（ブログ/スポット/ルート）を結合して sitemap.xml を返す。
// 以前は public/sitemap.xml が静的10件のみで、ユーザー生成コンテンツが一切
// インデックスされていなかった（成長施策：SEO対応）。
const STATIC_SITEMAP_URLS = [
  { loc: "https://biketeilen.web.app/", changefreq: "daily", priority: "1.0" },
  { loc: "https://biketeilen.web.app/about.html", changefreq: "monthly", priority: "0.9" },
  { loc: "https://biketeilen.web.app/support.html", changefreq: "monthly", priority: "0.6" },
  { loc: "https://biketeilen.web.app/routes.html", changefreq: "daily", priority: "0.8" },
  { loc: "https://biketeilen.web.app/blog/blog.html", changefreq: "weekly", priority: "0.7" },
  { loc: "https://biketeilen.web.app/badges/badges.html", changefreq: "monthly", priority: "0.5" },
  { loc: "https://biketeilen.web.app/conquest/conquest.html", changefreq: "monthly", priority: "0.5" },
  { loc: "https://biketeilen.web.app/completion/completion.html", changefreq: "monthly", priority: "0.5" },
  { loc: "https://biketeilen.web.app/privacypolicy/privacypolicy.html", changefreq: "yearly", priority: "0.3" },
  { loc: "https://biketeilen.web.app/termsofservice/termsofservice.html", changefreq: "yearly", priority: "0.3" },
];

// 現状のコーパス規模を把握する手段が無いため、安全側の上限として各コレクション最新5000件に制限。
// 将来URL数が数万件規模になった場合は sitemap index + 複数ファイル分割に切り替えること
// （sitemaps.org 仕様: 1ファイルあたり50,000URL/50MBまで）。
const SITEMAP_PER_COLLECTION_CAP = 5000;

function sitemapUrlEntry(loc, lastmod, changefreq, priority) {
  return [
    "  <url>",
    "    <loc>" + escapeHtml(loc) + "</loc>",
    lastmod ? "    <lastmod>" + lastmod + "</lastmod>" : "",
    "    <changefreq>" + changefreq + "</changefreq>",
    "    <priority>" + priority + "</priority>",
    "  </url>",
  ].filter(Boolean).join("\n");
}

function toLastmod(ts) {
  return ts && ts.toDate ? ts.toDate().toISOString().split("T")[0] : null;
}

exports.sitemapXml = functions.https.onRequest(async (req, res) => {
  try {
    const [blogSnap, spotSnap, routeSnap] = await Promise.all([
      db.collection("blog_posts").where("status", "==", "published")
        .orderBy("createdAt", "desc").limit(SITEMAP_PER_COLLECTION_CAP).get(),
      db.collection("imagedownload")
        .orderBy("createTimeTimeStamp", "desc").limit(SITEMAP_PER_COLLECTION_CAP).get(),
      db.collection("shared_routes")
        .orderBy("createdAt", "desc").limit(SITEMAP_PER_COLLECTION_CAP).get(),
    ]);

    const urls = [];
    STATIC_SITEMAP_URLS.forEach((u) => urls.push(sitemapUrlEntry(u.loc, null, u.changefreq, u.priority)));
    blogSnap.forEach((doc) => urls.push(sitemapUrlEntry(
      "https://biketeilen.web.app/blog/blog-detail.html?id=" + doc.id,
      toLastmod(doc.data().createdAt), "weekly", "0.6"
    )));
    spotSnap.forEach((doc) => urls.push(sitemapUrlEntry(
      "https://biketeilen.web.app/s/" + doc.id,
      toLastmod(doc.data().createTimeTimeStamp), "monthly", "0.5"
    )));
    routeSnap.forEach((doc) => urls.push(sitemapUrlEntry(
      "https://biketeilen.web.app/r/" + doc.id,
      toLastmod(doc.data().createdAt), "monthly", "0.5"
    )));

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join("\n") + "\n</urlset>";

    res.set("Content-Type", "application/xml");
    res.set("Cache-Control", "public, max-age=3600, s-maxage=7200");
    res.status(200).send(xml);
  } catch (error) {
    console.error("sitemapXml error:", error);
    res.status(500).send("<error>sitemap generation failed</error>");
  }
});

// ===== ウィンバック通知（エンゲージメント施策 Phase 1.1） =====
// 14日以上活動（スポット投稿・ルート保存・ルート公開）が無いユーザーに再エンゲージメント通知を送る。
// lastActivityAt はクライアント側（WinBackActivityTracker.swift）が上記アクション時に書き込む。
// 同じ非活動期間に対しては1回だけ送信し、再度活動が記録されるまで再送しない。
const WIN_BACK_INACTIVE_DAYS = 14;

exports.winBackNotification = onSchedule(
  { schedule: "every 24 hours", timeZone: "Asia/Tokyo" },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - WIN_BACK_INACTIVE_DAYS * 24 * 60 * 60 * 1000
    );

    const snapshot = await db
      .collection("userInfo")
      .where("lastActivityAt", "<=", cutoff)
      .get();

    if (snapshot.empty) {
      console.log("winBackNotification: 対象ユーザーなし");
      return null;
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const token = data.userFcmToken;
        const lastActivityAt = data.lastActivityAt;

        if (!token || token === "0") {
          skipped++;
          return;
        }

        // 同じ非活動期間に対して既に送信済みならスキップ
        const alreadyNotified =
          data.winBackNotifiedForActivity &&
          lastActivityAt &&
          data.winBackNotifiedForActivity.isEqual(lastActivityAt);
        if (alreadyNotified) {
          skipped++;
          return;
        }

        try {
          await admin.messaging().send({
            token,
            notification: {
              title: "最近ツーリングしていますか？",
              body: "しばらく記録がありません。お気に入りのスポットを見に行きませんか？",
            },
            data: { type: "win_back" },
          });
          await doc.ref.update({ winBackNotifiedForActivity: lastActivityAt });
          sent++;
        } catch (err) {
          failed++;
          console.error(`winBackNotification: 送信失敗 uid=${doc.id}`, err);
          // トークン失効時はクリーンアップ（次回以降の無駄な送信試行を防ぐ）
          if (
            err.code === "messaging/registration-token-not-registered" ||
            err.code === "messaging/invalid-registration-token"
          ) {
            await doc.ref.update({ userFcmToken: admin.firestore.FieldValue.delete() });
          }
        }
      })
    );

    console.log(
      `winBackNotification: 対象${snapshot.size}件 送信${sent}件 スキップ${skipped}件 失敗${failed}件`
    );
    return null;
  });