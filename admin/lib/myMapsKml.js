/**
 * myMapsKml.js
 *
 * Google マイマップ（`google.com/maps/d/`）から、規制の区間と両端を取り出す。
 *
 * 【なぜ必要か】
 * 都道府県警や二普協が、規制区間を**マイマップで公開している**ことがある。
 * 地図を目で見て座標を写すと間違えるし、区間の形（何百点）は写せない。
 * マイマップは KML で取り出せるので、そこから読む。
 *
 *   https://www.google.com/maps/d/kml?mid=<MID>&forcekml=1
 *
 * ⚠️ **`forcekml=1` を必ず付けること。** 付けないと KMZ（zip）で返り、
 *    そのままでは読めない。
 * ⚠️ 公開されている地図しか読めない（限定公開のものは 404 になる）。
 */
"use strict";

/** マイマップの URL から mid を取り出す。取れなければ null */
function midFrom(text) {
  if (!text) return null;
  const s = String(text).trim();
  // URL でなく mid そのものを渡されることもある
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  const m = s.match(/[?&]mid=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function kmlUrl(mid) {
  return `https://www.google.com/maps/d/kml?mid=${encodeURIComponent(mid)}&forcekml=1`;
}

/** タグの中身をすべて拾う（属性は見ない簡易な取り出し） */
function pickAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function pickOne(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}

function unescapeXml(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** "lng,lat,alt lng,lat,alt ..." → [[lng, lat], ...] */
function parseCoordinates(text) {
  const points = [];
  for (const chunk of String(text).trim().split(/\s+/)) {
    const parts = chunk.split(",");
    if (parts.length < 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    // ⚠️ KML は **経度が先**。緯度と取り違えると地球の裏側になる
    if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lng, lat]);
  }
  return points;
}

/**
 * KML を読んで、地点と線に分けて返す。
 *
 * @returns {{ title, description, places: [{name, lat, lng}], lines: [{name, points, lengthPoints}] }}
 */
function parseKml(xml) {
  const doc = pickOne(xml, "Document") || xml;
  const title = unescapeXml(pickOne(doc, "name"));
  const description = unescapeXml(pickOne(doc, "description")).replace(/<[^>]+>/g, "");

  const places = [];
  const lines = [];
  for (const pm of pickAll(xml, "Placemark")) {
    const name = unescapeXml(pickOne(pm, "name"));
    const point = pickOne(pm, "Point");
    const lineString = pickOne(pm, "LineString");
    if (point) {
      const [first] = parseCoordinates(pickOne(point, "coordinates"));
      if (first) places.push({ name, lat: first[1], lng: first[0] });
    } else if (lineString) {
      const points = parseCoordinates(pickOne(lineString, "coordinates"));
      if (points.length >= 2) lines.push({ name, points, lengthPoints: points.length });
    }
  }
  return { title, description, places, lines };
}

module.exports = { midFrom, kmlUrl, parseKml, parseCoordinates, unescapeXml };
