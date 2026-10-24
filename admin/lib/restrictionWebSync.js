/**
 * restrictionWebSync.js
 *
 * 開発用 Web（public/dev/winter-closures.html）で本番の road_restrictions に直接足した・直した・消した冬季閉鎖を、
 * 手元の data/road-restrictions へ取り込む（純ロジック）。
 *
 * ⚠️ 利用者の判断（2026-10-25）:「開発用webでも追加できるようにしたい」→ 公開サイトの /dev ページで本番に直接書く。
 * ⚠️ **配信（importRestrictions.js --commit）は県の規制を丸ごと上書きする。** 取り込まずに配信すると、
 *    /dev で足した道は消え、直した日付は手元の古い日付に戻り、消した道は生き返る。だから配信の前に必ずここを通す。
 *
 * 【/dev が残す印】
 *   restriction.editedOnWeb … /dev で足した・直した時刻（ISO）。手元のほうが新しければ手元を採る
 *   doc.deletedOnWeb        … /dev で消した id の並び。手元からも消す（取り込んだら本番の並びは空に戻す）
 */
"use strict";

/**
 * @param {Array} local 手元の restrictions
 * @param {object|null} prod 本番のドキュメント（{ restrictions, deletedOnWeb }）。無ければ null
 * @returns {{ restrictions: Array, added: string[], updated: string[], removed: string[] }}
 */
function mergeWebEdits(local, prod) {
  const out = (local || []).map((r) => r);
  const added = [], updated = [], removed = [];
  if (!prod) return { restrictions: out, added, updated, removed };

  const deleted = new Set(Array.isArray(prod.deletedOnWeb) ? prod.deletedOnWeb : []);
  for (let i = out.length - 1; i >= 0; i--) {
    if (deleted.has(out[i].id)) { removed.push(out[i].id); out.splice(i, 1); }
  }
  for (const r of prod.restrictions || []) {
    if (!r || !r.id || !r.editedOnWeb || deleted.has(r.id)) continue;
    const at = out.findIndex((x) => x.id === r.id);
    if (at < 0) { out.push(r); added.push(r.id); continue; }
    // ⚠️ 手元で後から直したもの（editedOnWeb が同じか新しい）は手元を採る
    if ((out[at].editedOnWeb || "") < r.editedOnWeb) { out[at] = r; updated.push(r.id); }
  }
  return { restrictions: out, added, updated, removed };
}

module.exports = { mergeWebEdits };
