# スタンプラリー 管理ツール 操作マニュアル

開発者がローカルでスタンプラリーを作成・投入・運用するためのツール一式。
設計の詳細は iOS 側の `touringSpotShare/STAMP_RALLY_DESIGN.md`（§11〜§13）を参照。

---

## 0. 準備

```bash
cd touring_spot_share_web/admin
npm install            # firebase-admin / express
```

**認証**（全ツール共通）。どちらか：
- `gcloud auth application-default login`（ADC・推奨／鍵ファイル不要）
- もしくは Firebase コンソール → プロジェクト設定 → サービスアカウント → 秘密鍵を `admin/serviceAccount.json` に保存（`.gitignore` 済み）

> ⚠️ いずれも **本番 Firestore（project: biketeilen）に読み書き**します。書き込み系は必ず `--dry-run` で確認してから。

---

## 1. ローカル作成サーバ（ビルダー）

```bash
node server.js          # → http://127.0.0.1:4317（ローカル専用）／npm run serve でも可
```

ブラウザで `http://127.0.0.1:4317` を開くと **地図ベースのラリービルダー**（Vue3 + Google Maps）。

### ビルダーでできること
- **ラリー情報**フォーム：rallyId / 名前 / テーマ / エリア / **都道府県**（選ぶと県別チャレンジに・region自動）/ 期間 / **季節(activeMonths)** / バッジ / 称号。
- **対象スポットの追加（5経路・マーカークリックで情報＋操作の InfoWindow）**
  - 🔵 **アプリ保存スポット**（青点。名前/住所で絞り込み。1週間キャッシュ＋新着のみ差分取得で読取最小化）
  - 🟢 **Web検索**（地名・施設名 → Nominatim で正確座標）
  - 🟣 **県データ**（「県データ読込」。手動追加はマゼンタ）
  - ⭐ **おすすめ**（「⭐おすすめ」読込。著名観光地。手動追加も）
  - 🟠 **地図クリック**（「地図クリックで地点追加」ON で任意地点 → 対象/県データ/おすすめへ）
- **InfoWindow**：マーカークリックで画像/名前/住所/座標＋[対象に追加]/[県+]/[⭐おすすめ+]（対象は[削除]）。
- **対象の編集**：名前編集・並べ替え（↑↓）・削除（✕）。
- **保存**：「Firestoreへ保存（upsert）」＝検証して `stampRallies` へ／「JSONダウンロード」。
- **既存ラリーの読込/複製/上書き**：右上「既存ラリーを読込」。
- **ラリー管理**：右上「🗂 管理」→ 一覧（状態フィルタ）で **編集／稼働・停止・終了／アーカイブ（論理削除・推奨）／完全削除（物理・確認必須）**。
- **県データ/おすすめ管理**：地図下パネルで名前編集・✕削除 →「更新」（PUT）。Web結果の「県+」「⭐+」でも蓄積。

> エンドポイントを追加・変更したら **server を再起動**。

---

## 2. ラリー定義（JSON）と投入

### スキーマ（1ラリー）
| キー | 必須 | 説明 |
|---|---|---|
| `rallyId` | ✓ | 一意ID。**年度内で固定・再利用しない**。ファイル名と揃えると管理しやすい |
| `name` / `theme` | ✓ | 表示名 / テーマ（michinoeki, zekkei, hanto, island, onsen, extreme, recommend…） |
| `fiscalYear` | ✓ | 年度(整数, 4/1〜3/31)。**フォルダ名 `--year` と一致必須** |
| `startAt` / `endAt` | ✓ | ISO8601（例 `2026-04-01T00:00:00+09:00`）。`startAt < endAt` |
| `targets[]` | ✓ | 対象スポット配列（1件以上） |
| `activeMonths` / `season` | 任意 | 季節限定。`[6,7,8]` または `"夏"`（空/未指定=通年） |
| `category` / `prefecture` | 任意 | `"standard"`(既定)/`"prefecture"` ＋ 県名（県別チャレンジ） |
| `region` / `description` / `coverImageURL` | 任意 | `coverImageURL` は URL手入力のほか、**「🎨生成」ボタン**でラリー情報からカバー画像をCanvas生成できる（プレビュー→画像DL／💾サーバ保存）。「💾サーバ保存」は `public/images/rallies/{rallyId}.jpg` に書き出し、URLを `https://biketeilen.web.app/images/rallies/{rallyId}.jpg` に自動設定（`firebase deploy` で反映） |
| `rewardBadgeId` / `completionTitle` | 任意 | 完了報酬・称号 |

### target
| キー | 必須 | 説明 |
|---|---|---|
| `targetId` | ✓ | ラリー内で一意。**年度内で変更しない**（変更するとユーザーのスタンプ紐付けがズレる） |
| `name` | ✓ | スポット名 |
| `lat` / `lng` | ✓ | 緯度経度（チェックインの300m判定に使用） |
| `order` | 任意 | 表示順（無ければ配列順） |
| `spotId` | 任意 | 既存スポット（`imagedownload` の docID）。あると重複を避けられる |
| `address` / `imageURL` | 任意 | |

- 季節キーワード：`通年/春/夏/秋/冬`・`all/spring/summer/autumn/winter`（importRallies が月へ展開）。
- `_note` などアンダースコア始まりキーは投入時に無視（メモ用）。

### 投入
```bash
node importRallies.js --year 2026 --dry-run     # 検証のみ（rallies/2026/*.json／1件でも不正なら中断）
node importRallies.js --year 2026               # 本番へ upsert（set merge:true）
node importRallies.js --file path/to/one.json   # 単体
```
- `importRallies` は `status` を書かない＝運用状態は後述の `setRallyStatus` 管理。**再投入で停止が解除されない**。
- 改訂も同じスクリプトで反映（既存フィールドを保ちつつ更新）。

---

## 3. 県別ラリーの一括生成

### 3-1. 各県の最東西南北（四端）
```bash
node genPrefectureRallies.js
# → generated/prefecture-extreme-2026/<romaji>-extreme-2026.json（47本）
```
- 出典：国土地理院の都道府県東西南北端点（DMS→十進）。
- 到達不能点は OVERRIDES で代替（北海道N/E=宗谷/納沙布、東京=雲取山/葛西臨海/城南島/高尾山、島根N=隠岐の島町）。
- 北海道の南西端（離島）は要差し替えフラグ。`_note` 参照。

### 3-2. 各県のおすすめスポット（データ参照・一気通貫）
```bash
# 1) おすすめスポットデータを生成（著名地名を Nominatim でジオコーディング）
node savePrefectureRecommend.js
#    lib/prefectureRecommendSeed.js（県別の著名スポット名）→ data/prefecture-recommend/<romaji>.json
#    ※「名前 県名」でヒットしなければ「名前」単独で再検索。手動追加(manual)はマージ保持。約5分。
# 2) データからラリーJSONを生成
node genPrefectureRecommend.js
#    data/prefecture-recommend/ を読んで → generated/prefecture-recommend-2026/<romaji>-recommend-2026.json
```
- 座標は地図サービス由来。**ビルダーの⭐おすすめで編集 → genPrefectureRecommend を再実行**で反映（一気通貫）。
- スポットを増やす：`lib/prefectureRecommendSeed.js` に名前を追記 → 1) を再実行。

### 3-3. 県別ラリーの投入
```bash
for f in generated/prefecture-extreme-2026/*.json;   do node importRallies.js --file "$f"; done
for f in generated/prefecture-recommend-2026/*.json; do node importRallies.js --file "$f"; done
```
> `generated/` は `rallies/<year>/` の外＝`--year` 一括投入に含まれない（誤投入防止）。

### 3-4. 座標の精緻化フロー
1. 投入 → 2. ビルダー「既存ラリーを読込」→ 3. ズレた対象を✕削除し Web検索/県データ/地図クリックで正しい地点を追加 → 4.「Firestoreへ保存（upsert）」。

---

## 4. 県別スポットデータ（ビルダーの素材）

```bash
node savePrefectureData.js
# アプリの imagedownload を県別(administrative)に集約 → data/prefecture-spots/<romaji>.json
```
- 各スポットに `source`：`app`（アプリ由来）/ `manual`（ビルダー手動追加）。
- **再実行してもアプリ最新を取り込みつつ、手動追加(`manual`)はマージ保持**。
- ビルダー「県データ読込」で 🟣 表示 → クリックで対象に。Web結果「県+」「対象を県データに保存」で蓄積。
- ⚠️ アプリ由来(`app`)の編集/削除は再実行で元に戻る（恒久にしたい名所は手動追加が確実）。

### 4-2. おすすめデータ（県データと並列・dataset=recommend）
- `data/prefecture-recommend/<romaji>.json`（生成元: §3-2）。ビルダー「⭐おすすめ」で読込（金色）→ クリックで対象に。
- `source`: `curated`（シード）/ `manual`（ビルダー追加）。`savePrefectureRecommend.js` 再実行で manual はマージ保持。
- 県データ(spots)とおすすめ(recommend)は**同一 API の dataset 違い**（§6）。Web結果「⭐+」「⭐おすすめ管理」で編集。

---

## 5. ラリーの停止・削除・季節

```bash
node setRallyStatus.js --list [--year 2026]                 # 状態一覧
node setRallyStatus.js --rally <id> --status paused          # 一時停止（再開可）
node setRallyStatus.js --rally <id> --status active          # 再開
node setRallyStatus.js --rally <id> --status ended --end-now # 終了（endAtもnow）
node setRallyStatus.js --rally <id> --status archived        # 論理削除（=削除）
node setRallyStatus.js --year 2026 --status paused           # 年度一括
# どれも --dry-run 可
```
- status: `active`/`paused`/`ended`/`archived`。**獲得スタンプ・バッジ・称号は剥奪しない**。物理削除はしない。
- 季節は **コンテンツ**（JSON の activeMonths/season）。シーズン外は一覧に残り「受付終了/淡色」表示。

---

## 6. API リファレンス（server.js / 127.0.0.1）

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/` | ビルダー（rally-builder.html） |
| GET | `/api/spots?limit=` | アプリ保存スポット（imagedownload） |
| GET | `/api/geocode?q=` | Web地名検索（Nominatim・日本限定） |
| GET | `/api/prefectures` | 県マスタ（name/romaji/region＋県データ/おすすめ件数） |
| GET·POST·PUT | `/api/prefecture-data/:dataset/:romaji` | 県別データ（dataset=`spots`\|`recommend`）取得/追加/全置換 |
| GET·POST·PUT | `/api/prefecture-spots/:romaji` | 上記 `spots` の互換エイリアス |
| GET | `/api/rallies?year=` | 既存ラリー一覧 |
| GET | `/api/rally/:id` | 1ラリー取得（編集/複製） |
| POST | `/api/rally` | 検証して stampRallies へ upsert |
| POST | `/api/rally/:id/status` | 状態変更（active/paused/ended/archived。ended は endNow で endAt=now） |
| DELETE | `/api/rally/:id` | 物理削除（通常は status=archived 推奨） |
| POST | `/api/rally-cover/:rallyId` | 「🎨生成」のカバー画像（`{dataUrl}` JPEG/PNG base64）を `../public/images/rallies/{rallyId}.jpg` へ書き出し |

> ⚠️ `/api/rally-cover`・`/api/rally/:id/status`・`DELETE /api/rally/:id` は新規エンドポイント。**server.js を再起動**してから使うこと。

---

## 7. ファイル構成

```
admin/
  server.js                      ローカル作成サーバ
  public/rally-builder.html      ビルダーUI（Vue3 + Google Maps）
  lib/rallyValidation.js         ラリー検証（共用）
  lib/prefectures.js             県メタ（romaji/region・共用）
  lib/prefectureRecommendSeed.js おすすめ著名スポット名（シード）
  importRallies.js               ラリー投入
  setRallyStatus.js              状態管理（停止/削除/年度一括）
  genPrefectureRallies.js        県別 最東西南北 生成
  genPrefectureRecommend.js      県別 おすすめ 生成（data/prefecture-recommend/ 参照）
  savePrefectureData.js          県データ保存（アプリ由来 imagedownload）
  savePrefectureRecommend.js     おすすめ保存（シード名→ジオコーディング）
  rallies/<year>/*.json          ラリー定義（テーマ別・四極など）
  generated/prefecture-*/        生成された県別ラリー（投入待ち）
  data/prefecture-spots/         県データ（アプリ由来＋手動）
  data/prefecture-recommend/     おすすめ（著名＋手動）
```

---

## 8. アプリ側の表示

- 実績タブ → **「スタンプラリー」**（標準：テーマ別・四極）。履歴（年・月別）/どこ行こ/Web公開トグル。
- 実績タブ → **「都道府県別チャレンジ」**（`category:"prefecture"`：地方チップ→県カード→詳細の地図）。
- Web 公開：`user.html?id=<uid>` で年度別の獲得数（本人が公開設定時）。

---

## 9. 年度切替

新年度フォルダ（例 `rallies/2027/`）に JSON を足して `--year 2027` で投入。生成器は `FY` を変更。
**過去年度のマスタは削除しない**（ユーザーの過去スタンプ閲覧のため読取可のまま）。

---

## 10. 注意

- server は **127.0.0.1 のみ**。公開しない。`POST/PUT` は本番 Firestore／ローカルファイルへ書き込む。
- `node_modules` / `serviceAccount.json` は `.gitignore` 済み。`data/`・`generated/` は生成物（コミット要否は運用判断）。
- Nominatim は低頻度利用（ボタン/Enter実行のみ）。
- 検証規則は `lib/rallyValidation.js` と `importRallies.js` のインライン版を**同一に保つ**こと。
- 公開前にテスト用 uid でアプリ表示・チェックイン・写真付与を確認。
