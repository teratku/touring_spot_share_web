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