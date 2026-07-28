/**
 * japan-map.js
 *
 * 日本地図の形で都道府県を塗り分ける（SVG）。
 * タイル状の四角に代わるもので、iOS の経県値マップと同じ見た目・同じデータを使う。
 *
 * 【データ】
 * japan-prefectures.geojson（Natural Earth 1:10m 由来・パブリックドメイン）。
 * iOS 側と同じファイルをそのまま置いている。出どころと加工内容は
 * biketeilen_iOS_clean/docs/japan-prefectures-data.md を参照。
 *
 * 【iOS 側と揃えていること】
 * ・Web メルカトルで投影する（緯度をそのまま y にすると南北が詰まって形が崩れる）
 * ・縦横比を保つ（保たないと日本が太る）
 * ・沖縄だけ別枠（インセット）に入れて右下に置く
 *   そのまま描くと日本列島が隅に寄って小さくなるため。左下は九州が占めているので右下。
 * 対応する Swift は JapanMapGeometry.swift / JapanMapLoader.swift。
 *
 * 【使い方】
 *   const map = await JapanMap.create("#mapContainer");
 *   map.paint({
 *     fill: (pref) => visited.includes(pref.name) ? "#00a8c6" : "#eee",
 *     label: (pref) => pref.area > 0.002 ? "10%" : "",  // pref.area で大きさが分かる
 *     title: (pref) => `${pref.name}`,     // ツールチップ・省略可
 *     onClick: (pref) => { ... },          // 省略可
 *   });
 * 塗り替えるだけなら paint() を呼び直す（作り直さないので速い）。
 */
(function (global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  /** 沖縄インセットの位置（本土の枠を 0〜1 とした相対値）。iOS の okinawaInset と同じ */
  const OKINAWA_INSET = { x: 0.70, y: 0.70, w: 0.28, h: 0.28 };
  const OKINAWA_CODE = 47;

  const PREF_NAMES = [
    null,
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
    "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
  ];

  /** "JP-13" → 13 */
  function isoCode(raw) {
    if (typeof raw !== "string") return null;
    const parts = raw.split("-");
    if (parts.length !== 2 || parts[0].toUpperCase() !== "JP") return null;
    const id = Number(parts[1]);
    return Number.isInteger(id) && id >= 1 && id <= 47 ? id : null;
  }

  /** Web メルカトル。経度はそのまま、緯度だけ変換する */
  function project(lng, lat) {
    const clamped = Math.max(-85, Math.min(85, lat));
    const y = (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) * 180) / Math.PI;
    return [lng, y];
  }

  /** GeoJSON の geometry から外周リングを取り出す（穴は無視。県境に穴はほぼ無い） */
  function ringsOf(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates.slice(0, 1);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.map((poly) => poly[0]);
    if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(ringsOf);
    return [];
  }

  /** 符号なしの面積。島の大小を比べるためだけに使う */
  function ringArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(sum) / 2;
  }

  /**
   * 投影済みのリング群を、上下反転しつつ 0〜1 に収める。
   * 画面の y は下向きなので、メルカトルの y（北が大きい）を反転する。
   */
  function normalize(groups) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const ring of groups) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0 && height > 0)) return { rings: groups, aspect: 1 };
    // 長い辺を 1 に合わせ、短い辺は比率のまま中央に寄せる
    const scale = 1 / Math.max(width, height);
    const offsetX = (1 - width * scale) / 2;
    const offsetY = (1 - height * scale) / 2;
    const rings = groups.map((ring) =>
      ring.map(([x, y]) => [
        (x - minX) * scale + offsetX,
        (maxY - y) * scale + offsetY,   // y 反転（北を上に）
      ])
    );
    return { rings, aspect: width / height };
  }

  /** 交差数判定。ラベル位置が県の外に出ていないか確かめるのに使う */
  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y)) {
        const cross = xi + ((y - yi) / (yj - yi)) * (xj - xi);
        if (x < cross) inside = !inside;
      }
    }
    return inside;
  }

  /**
   * 県名を置く位置。
   * ⚠️ ただの重心だと、湾や半島でくぼんだ県（青森・高知・長崎など）で県の外に出る。
   *    重心が外なら、横に切っていって内側が一番長く続くところの中点にする。
   */
  function labelAnchor(rings) {
    const main = rings.reduce((a, b) => (ringArea(a) >= ringArea(b) ? a : b));
    let sx = 0, sy = 0;
    for (const [x, y] of main) { sx += x; sy += y; }
    const centroid = [sx / main.length, sy / main.length];
    if (ringContains(main, centroid[0], centroid[1])) return centroid;

    const ys = main.map((p) => p[1]);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    let best = null, bestWidth = -1;
    for (let step = 1; step <= 24; step++) {
      const y = minY + ((maxY - minY) * step) / 25;
      const crossings = [];
      for (let i = 0, j = main.length - 1; i < main.length; j = i++) {
        const [xi, yi] = main[i];
        const [xj, yj] = main[j];
        if ((yi > y) !== (yj > y)) crossings.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const width = crossings[i + 1] - crossings[i];
        if (width > bestWidth) { bestWidth = width; best = [(crossings[i] + crossings[i + 1]) / 2, y]; }
      }
    }
    return best || centroid;
  }

  function ringToPath(ring, box) {
    let d = "";
    for (let i = 0; i < ring.length; i++) {
      const x = box.x + ring[i][0] * box.w;
      const y = box.y + ring[i][1] * box.h;
      d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
    }
    return d + "Z";
  }

  let cachedGeo = null;

  async function loadGeometry(url) {
    if (cachedGeo) return cachedGeo;
    const raw = await (await fetch(url)).json();
    const byCode = new Map();
    for (const feature of raw.features || []) {
      const code = isoCode((feature.properties || {}).iso_3166_2);
      if (!code) continue;
      const rings = ringsOf(feature.geometry)
        .filter((r) => r && r.length >= 4)
        .map((r) => r.map(([lng, lat]) => project(lng, lat)));
      if (!rings.length) continue;
      byCode.set(code, (byCode.get(code) || []).concat(rings));
    }

    const mainlandCodes = [...byCode.keys()].filter((c) => c !== OKINAWA_CODE).sort((a, b) => a - b);
    const flat = mainlandCodes.flatMap((c) => byCode.get(c));
    const { rings: normalized, aspect } = normalize(flat);
    let cursor = 0;
    const mainland = mainlandCodes.map((code) => {
      const count = byCode.get(code).length;
      const rings = normalized.slice(cursor, cursor + count);
      cursor += count;
      // 描画上の大きさ（0〜1の枠での面積）。小さい県はラベルが入らないので、
      // 呼び出し側が「出すかどうか」を決められるように渡す
      const area = rings.reduce((a, r) => a + ringArea(r), 0);
      return { code, name: PREF_NAMES[code], rings, anchor: labelAnchor(rings), area };
    });

    let okinawa = [];
    if (byCode.has(OKINAWA_CODE)) {
      const { rings } = normalize(byCode.get(OKINAWA_CODE));
      okinawa = [{ code: OKINAWA_CODE, name: PREF_NAMES[OKINAWA_CODE], rings,
                   anchor: labelAnchor(rings), area: rings.reduce((a, r) => a + ringArea(r), 0) }];
    }

    cachedGeo = { mainland, okinawa, aspect };
    return cachedGeo;
  }

  class JapanMap {
    constructor(container, geo, options) {
      this.geo = geo;
      this.options = options;
      this.paths = new Map();
      this.labels = new Map();

      const size = options.size || 520;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
      svg.setAttribute("width", "100%");
      svg.style.maxWidth = size + "px";
      svg.style.display = "block";
      svg.style.margin = "0 auto";
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "日本地図");
      this.svg = svg;

      const main = { x: 0, y: 0, w: size, h: size };
      const inset = {
        x: OKINAWA_INSET.x * size, y: OKINAWA_INSET.y * size,
        w: OKINAWA_INSET.w * size, h: OKINAWA_INSET.h * size,
      };

      // 沖縄が別枠だと分かるように薄い枠を描く
      const frame = document.createElementNS(SVG_NS, "rect");
      frame.setAttribute("x", inset.x); frame.setAttribute("y", inset.y);
      frame.setAttribute("width", inset.w); frame.setAttribute("height", inset.h);
      frame.setAttribute("rx", "6");
      frame.setAttribute("fill", "none");
      frame.setAttribute("stroke", "rgba(0,0,0,.14)");
      frame.setAttribute("stroke-width", "1");
      svg.appendChild(frame);

      for (const [list, box] of [[geo.mainland, main], [geo.okinawa, inset]]) {
        for (const pref of list) {
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("d", pref.rings.map((r) => ringToPath(r, box)).join(" "));
          path.setAttribute("stroke", "#fff");
          path.setAttribute("stroke-width", "0.8");
          path.setAttribute("stroke-linejoin", "round");
          path.style.transition = "fill .15s";
          svg.appendChild(path);
          this.paths.set(pref.code, { el: path, pref, box });
        }
      }

      // 文字は塗りより手前に置く（塗りに隠れないように）
      for (const [list, box] of [[geo.mainland, main], [geo.okinawa, inset]]) {
        for (const pref of list) {
          const text = document.createElementNS(SVG_NS, "text");
          text.setAttribute("x", box.x + pref.anchor[0] * box.w);
          text.setAttribute("y", box.y + pref.anchor[1] * box.h);
          text.setAttribute("text-anchor", "middle");
          text.setAttribute("dominant-baseline", "central");
          text.setAttribute("font-size", Math.max(7, size / 58));
          text.setAttribute("font-weight", "600");
          text.style.pointerEvents = "none";
          svg.appendChild(text);
          this.labels.set(pref.code, text);
        }
      }

      container.innerHTML = "";
      container.appendChild(svg);
    }

    /** 塗り替える。作り直さないので何度呼んでも軽い */
    paint(spec) {
      const { fill, label, title, onClick, textColor } = spec || {};
      for (const [code, entry] of this.paths) {
        const pref = entry.pref;
        entry.el.setAttribute("fill", (fill && fill(pref)) || "#e9ecef");
        entry.el.style.cursor = onClick ? "pointer" : "default";
        entry.el.onclick = onClick ? () => onClick(pref) : null;

        // ツールチップ
        let tip = entry.el.querySelector("title");
        const tipText = title ? title(pref) : pref.name;
        if (tipText) {
          if (!tip) { tip = document.createElementNS(SVG_NS, "title"); entry.el.appendChild(tip); }
          tip.textContent = tipText;
        } else if (tip) entry.el.removeChild(tip);

        const text = this.labels.get(code);
        text.textContent = label ? (label(pref) || "") : "";
        text.setAttribute("fill", (textColor && textColor(pref)) || "rgba(0,0,0,.62)");
      }
    }

    /** 1県だけ強調する（選択の表示） */
    highlight(code) {
      for (const [c, entry] of this.paths) {
        const on = c === code;
        entry.el.setAttribute("stroke", on ? "#e8590c" : "#fff");
        entry.el.setAttribute("stroke-width", on ? "2.2" : "0.8");
        // 選択中を最前面へ（重なった県境に隠れないように）
        if (on) this.svg.appendChild(entry.el);
      }
    }
  }

  /**
   * @param {string|Element} target 描画先
   * @param {{ size?: number, geojsonUrl?: string }} options
   */
  JapanMap.create = async function (target, options = {}) {
    const container = typeof target === "string" ? document.querySelector(target) : target;
    if (!container) throw new Error("描画先が見つかりません: " + target);
    const url = options.geojsonUrl || "/conquest/japan-prefectures.geojson";
    const geo = await loadGeometry(url);
    return new JapanMap(container, geo, options);
  };

  global.JapanMap = JapanMap;
})(window);
