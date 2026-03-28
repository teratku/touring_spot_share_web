/**
 * prefecture-data.js
 * 47都道府県の定数データ
 * - グリッドマップ表示位置
 * - 地方区分
 * - バウンディングボックス（座標→都道府県判定用）
 */

const REGIONS = {
    "北海道":   { color: "#5DCAA5", label: "北海道" },
    "東北":     { color: "#85B7EB", label: "東北" },
    "関東":     { color: "#AFA9EC", label: "関東" },
    "中部":     { color: "#F0997B", label: "中部" },
    "近畿":     { color: "#ED93B1", label: "近畿" },
    "中国":     { color: "#97C459", label: "中国" },
    "四国":     { color: "#FAC775", label: "四国" },
    "九州沖縄": { color: "#F09595", label: "九州・沖縄" }
};

/**
 * 47都道府県データ
 * gridRow / gridCol: タイルグリッドマップ上の表示位置
 * region: 地方区分キー
 * bounds: 緯度経度のバウンディングボックス（座標→都道府県判定用）
 */
const PREFECTURES = [
    { code: 1,  name: "北海道",   gridRow: 0, gridCol: 7, region: "北海道",   bounds: { latMin: 41.35, latMax: 45.55, lngMin: 139.30, lngMax: 145.82 } },
    { code: 2,  name: "青森県",   gridRow: 1, gridCol: 7, region: "東北",     bounds: { latMin: 40.22, latMax: 41.55, lngMin: 139.49, lngMax: 141.68 } },
    { code: 3,  name: "岩手県",   gridRow: 2, gridCol: 7, region: "東北",     bounds: { latMin: 38.75, latMax: 40.45, lngMin: 140.65, lngMax: 142.08 } },
    { code: 4,  name: "宮城県",   gridRow: 3, gridCol: 7, region: "東北",     bounds: { latMin: 37.78, latMax: 39.00, lngMin: 140.28, lngMax: 141.68 } },
    { code: 5,  name: "秋田県",   gridRow: 2, gridCol: 6, region: "東北",     bounds: { latMin: 39.00, latMax: 40.52, lngMin: 139.70, lngMax: 140.98 } },
    { code: 6,  name: "山形県",   gridRow: 3, gridCol: 6, region: "東北",     bounds: { latMin: 37.73, latMax: 39.22, lngMin: 139.52, lngMax: 140.65 } },
    { code: 7,  name: "福島県",   gridRow: 4, gridCol: 7, region: "東北",     bounds: { latMin: 36.79, latMax: 37.97, lngMin: 139.17, lngMax: 141.05 } },
    { code: 8,  name: "茨城県",   gridRow: 5, gridCol: 7, region: "関東",     bounds: { latMin: 35.74, latMax: 36.97, lngMin: 139.69, lngMax: 140.85 } },
    { code: 9,  name: "栃木県",   gridRow: 4, gridCol: 6, region: "関東",     bounds: { latMin: 36.20, latMax: 37.16, lngMin: 139.33, lngMax: 140.30 } },
    { code: 10, name: "群馬県",   gridRow: 4, gridCol: 5, region: "関東",     bounds: { latMin: 36.07, latMax: 37.06, lngMin: 138.64, lngMax: 139.68 } },
    { code: 11, name: "埼玉県",   gridRow: 5, gridCol: 6, region: "関東",     bounds: { latMin: 35.76, latMax: 36.29, lngMin: 138.72, lngMax: 139.91 } },
    { code: 12, name: "千葉県",   gridRow: 6, gridCol: 7, region: "関東",     bounds: { latMin: 34.90, latMax: 36.00, lngMin: 139.75, lngMax: 140.87 } },
    { code: 13, name: "東京都",   gridRow: 6, gridCol: 6, region: "関東",     bounds: { latMin: 35.50, latMax: 35.90, lngMin: 138.94, lngMax: 139.92 } },
    { code: 14, name: "神奈川県", gridRow: 7, gridCol: 6, region: "関東",     bounds: { latMin: 35.13, latMax: 35.67, lngMin: 138.92, lngMax: 139.78 } },
    { code: 15, name: "新潟県",   gridRow: 3, gridCol: 5, region: "中部",     bounds: { latMin: 36.76, latMax: 38.56, lngMin: 137.84, lngMax: 140.03 } },
    { code: 16, name: "富山県",   gridRow: 4, gridCol: 3, region: "中部",     bounds: { latMin: 36.27, latMax: 36.99, lngMin: 136.77, lngMax: 137.76 } },
    { code: 17, name: "石川県",   gridRow: 4, gridCol: 2, region: "中部",     bounds: { latMin: 36.07, latMax: 37.85, lngMin: 136.23, lngMax: 137.40 } },
    { code: 18, name: "福井県",   gridRow: 5, gridCol: 2, region: "中部",     bounds: { latMin: 35.37, latMax: 36.29, lngMin: 135.53, lngMax: 136.82 } },
    { code: 19, name: "山梨県",   gridRow: 6, gridCol: 5, region: "中部",     bounds: { latMin: 35.20, latMax: 35.93, lngMin: 138.18, lngMax: 139.16 } },
    { code: 20, name: "長野県",   gridRow: 5, gridCol: 4, region: "中部",     bounds: { latMin: 35.18, latMax: 37.03, lngMin: 137.32, lngMax: 138.72 } },
    { code: 21, name: "岐阜県",   gridRow: 5, gridCol: 3, region: "中部",     bounds: { latMin: 35.14, latMax: 36.47, lngMin: 136.26, lngMax: 137.65 } },
    { code: 22, name: "静岡県",   gridRow: 6, gridCol: 4, region: "中部",     bounds: { latMin: 34.58, latMax: 35.64, lngMin: 137.47, lngMax: 139.18 } },
    { code: 23, name: "愛知県",   gridRow: 6, gridCol: 3, region: "中部",     bounds: { latMin: 34.58, latMax: 35.43, lngMin: 136.67, lngMax: 137.83 } },
    { code: 24, name: "三重県",   gridRow: 6, gridCol: 2, region: "近畿",     bounds: { latMin: 33.73, latMax: 35.18, lngMin: 135.85, lngMax: 136.98 } },
    { code: 25, name: "滋賀県",   gridRow: 5, gridCol: 1, region: "近畿",     bounds: { latMin: 34.76, latMax: 35.70, lngMin: 135.76, lngMax: 136.45 } },
    { code: 26, name: "京都府",   gridRow: 4, gridCol: 1, region: "近畿",     bounds: { latMin: 34.56, latMax: 35.78, lngMin: 134.85, lngMax: 136.06 } },
    { code: 27, name: "大阪府",   gridRow: 6, gridCol: 1, region: "近畿",     bounds: { latMin: 34.27, latMax: 34.98, lngMin: 135.10, lngMax: 135.75 } },
    { code: 28, name: "兵庫県",   gridRow: 6, gridCol: 0, region: "近畿",     bounds: { latMin: 34.15, latMax: 35.67, lngMin: 134.25, lngMax: 135.47 } },
    { code: 29, name: "奈良県",   gridRow: 7, gridCol: 2, region: "近畿",     bounds: { latMin: 33.85, latMax: 34.79, lngMin: 135.57, lngMax: 136.22 } },
    { code: 30, name: "和歌山県", gridRow: 7, gridCol: 1, region: "近畿",     bounds: { latMin: 33.43, latMax: 34.38, lngMin: 135.07, lngMax: 136.00 } },
    { code: 31, name: "鳥取県",   gridRow: 5, gridCol: 0, region: "中国",     bounds: { latMin: 35.07, latMax: 35.62, lngMin: 133.14, lngMax: 134.51 } },
    { code: 32, name: "島根県",   gridRow: 4, gridCol: 0, region: "中国",     bounds: { latMin: 34.30, latMax: 36.08, lngMin: 131.67, lngMax: 133.39 } },
    { code: 33, name: "岡山県",   gridRow: 7, gridCol: 0, region: "中国",     bounds: { latMin: 34.35, latMax: 35.35, lngMin: 133.26, lngMax: 134.42 } },
    { code: 34, name: "広島県",   gridRow: 8, gridCol: 0, region: "中国",     bounds: { latMin: 34.05, latMax: 35.12, lngMin: 132.04, lngMax: 133.40 } },
    { code: 35, name: "山口県",   gridRow: 9, gridCol: 0, region: "中国",     bounds: { latMin: 33.74, latMax: 34.77, lngMin: 130.79, lngMax: 132.27 } },
    { code: 36, name: "徳島県",   gridRow: 8, gridCol: 2, region: "四国",     bounds: { latMin: 33.72, latMax: 34.26, lngMin: 133.62, lngMax: 134.80 } },
    { code: 37, name: "香川県",   gridRow: 8, gridCol: 1, region: "四国",     bounds: { latMin: 34.03, latMax: 34.50, lngMin: 133.46, lngMax: 134.45 } },
    { code: 38, name: "愛媛県",   gridRow: 9, gridCol: 1, region: "四国",     bounds: { latMin: 32.90, latMax: 34.00, lngMin: 132.01, lngMax: 133.69 } },
    { code: 39, name: "高知県",   gridRow: 9, gridCol: 2, region: "四国",     bounds: { latMin: 32.71, latMax: 33.88, lngMin: 132.47, lngMax: 134.30 } },
    { code: 40, name: "福岡県",   gridRow: 9, gridCol: -2, region: "九州沖縄", bounds: { latMin: 33.00, latMax: 33.97, lngMin: 130.02, lngMax: 131.19 } },
    { code: 41, name: "佐賀県",   gridRow: 9, gridCol: -3, region: "九州沖縄", bounds: { latMin: 32.96, latMax: 33.60, lngMin: 129.74, lngMax: 130.56 } },
    { code: 42, name: "長崎県",   gridRow: 10, gridCol: -3, region: "九州沖縄", bounds: { latMin: 32.57, latMax: 34.73, lngMin: 128.60, lngMax: 130.35 } },
    { code: 43, name: "熊本県",   gridRow: 10, gridCol: -2, region: "九州沖縄", bounds: { latMin: 32.08, latMax: 33.19, lngMin: 130.11, lngMax: 131.26 } },
    { code: 44, name: "大分県",   gridRow: 8, gridCol: -1, region: "九州沖縄", bounds: { latMin: 32.71, latMax: 33.75, lngMin: 130.82, lngMax: 132.11 } },
    { code: 45, name: "宮崎県",   gridRow: 10, gridCol: -1, region: "九州沖縄", bounds: { latMin: 31.36, latMax: 32.94, lngMin: 130.69, lngMax: 131.88 } },
    { code: 46, name: "鹿児島県", gridRow: 11, gridCol: -2, region: "九州沖縄", bounds: { latMin: 27.02, latMax: 32.32, lngMin: 128.40, lngMax: 131.32 } },
    { code: 47, name: "沖縄県",   gridRow: 12, gridCol: -3, region: "九州沖縄", bounds: { latMin: 24.05, latMax: 27.89, lngMin: 122.93, lngMax: 131.33 } }
];

/**
 * 座標からバウンディングボックスで都道府県を判定
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @returns {string|null} 都道府県名 or null
 */
function detectPrefectureFromCoordinate(lat, lng) {
    for (const pref of PREFECTURES) {
        const b = pref.bounds;
        if (lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax) {
            return pref.name;
        }
    }
    return null;
}