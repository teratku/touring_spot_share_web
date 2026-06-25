const functions = require("firebase-functions");
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

exports.spotShare = functions.https.onRequest(async (req, res) => {
  const id = pathId(req);
  const real = "https://biketeilen.web.app/detail.html?id=" + encodeURIComponent(id);
  try {
    let title = "ツーリングスポット";
    let image = "https://biketeilen.web.app/images/ogp.png";
    let desc = "バイクで行きたいツーリングスポット｜ツーリングスポットシェア";
    if (id) {
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
  const real = "https://biketeilen.web.app/user.html?id=" + encodeURIComponent(id);
  try {
    let title = "ユーザー";
    let image = "https://biketeilen.web.app/images/ogp.png";
    let desc = "投稿スポット・ルート・スタンプラリー｜ツーリングスポットシェア";
    if (id) {
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