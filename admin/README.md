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

---

## 11. ローカルでブログを確認する（本番とテスト環境の差異を無くす）

`blog-detail.html`（`functions/blogSSR`）は記事本文の他に `imagedownload`（スポット）/
`shared_routes`（ルート）も読んで `{{spot:xxx}}` 等の埋め込みカードを描画する。
Firestoreエミュレータは空データで起動するため、そのままだと本番と表示が食い違う
（記事が「見つかりません」になったり、埋め込みが展開されず生テキストのまま出たりする）。

### 手順

```bash
# 1) エミュレータを「永続化あり」で起動（初回のみ --import 先が無くてもエラーにならない）
cd admin && npm run emulators
#   実体: cd .. && firebase emulators:start --import=./admin/emulator-data --export-on-exit

# 2) 別ターミナルで、本番の blog_posts と、記事が参照する spot/route だけをローカルへ同期
cd admin && npm run sync-blog-data
```

`--export-on-exit` により、Ctrl+C で終了するたびに `admin/emulator-data/`
（`.gitignore` 済み・コミットしない）へ自動保存され、**次回からは `npm run emulators`
だけでデータが復元される**（`sync-blog-data` の再実行は、本番に新しい記事/スポットを
追加した後だけでよい）。

`syncBlogTestData.js` は読み取りを本番Firestoreから行うだけで、**本番データへの書込みは一切行わない**
（書込み先は常にローカルエミュレータ）。
- 検証規則は `lib/rallyValidation.js` と `importRallies.js` のインライン版を**同一に保つ**こと。
- 公開前にテスト用 uid でアプリ表示・チェックイン・写真付与を確認。

---

# おすすめ道路（road_recommend）操作マニュアル

道路データから「走って楽しい区間」を**開発者のPCで一括生成して配信する**仕組み。
アプリ側は読むだけになるので、以前のように端末で毎回曲率を計算しない。

## 0. 元データ

`~/Documents/grid_csvs_japan_empty/`（4,587ファイル / 266MB / 0.1度グリッド）

⚠️ **`~/Downloads/python/` を使ってはいけない。** 列は豊富（`prefecture` / `city` を持つ）が
緯度 24.0〜36.0度ぶんしか無く、**北海道・東北6県・栃木・群馬・新潟・富山・石川の12県が
丸ごと欠けている**。いろは坂も草津も入らない。
全国側は列が `osm_id,name,highway,ref,geometry` の5つだけなので、
都道府県は座標から判定する（`lib/prefectureLocator.js`）。

## 1. 元データの確認（作り直すときは毎回やる）

```bash
cd admin
node buildRoadRecommend.js --audit            # 全国 25秒
node buildRoadRecommend.js --audit --limit 200 # 一部だけ見る
```

47県すべてに道路があるか、`highway` の分布、欠損率が出る。
**「❌ N県が欠けている」が出たら生成に進まないこと。**

## 2. 生成

```bash
node buildRoadRecommend.js --build                      # 全国 22秒 → data/road-recommend/*.json
node buildRoadRecommend.js --build --prefecture 栃木県   # 1県だけ試す
node --test test/                                       # 純粋関数のテスト
```

出力に必ず目を通すところが2つある。

- **信号の分布** … 「振り切れ」が2割を超えたら `lib/funSegments.js` の `NORMALIZERS` を
  90パーセンタイル付近へ直す。振り切れていると上位の点数が潰れて順位がつかない。
- **既知の道の順位** … いろは坂・妙義・美ヶ原などが上位に来ているか。
  来ていなければ重みか区間の切り出しが間違っている。
  ⚠️ 正解リストは **OSM に載っている名前**で書くこと。「椿ライン」「ヤビツ峠」「麦草峠」
  「金精道路」「霧降高原道路」はいずれも名前として存在しない（椿ラインは正式名の
  「湯河原箱根線」で入っている）。通称で書くと、取れているのに「抜き出せていない」と出る。

## 3. 配信

```bash
node importRoadRecommend.js --all                     # 検証のみ（既定・書き込まない）
node importRoadRecommend.js --prefecture 栃木県 --commit # 1県だけ投入
node importRoadRecommend.js --all --commit            # 全県投入
```

- Storage `Json/road_recommend/<romaji>_v<generation>.json` … 本体（1県 80KB 前後）
- Firestore `road_recommend/_index` … 全県ぶんの世代表。**アプリはこれ1件だけ読む**
- Firestore `road_recommend/<romaji>` … 県ごとの明細（運用の確認用）

⚠️ `generation` を上げるとアプリのキャッシュが失効して再ダウンロードが走る。
**47県ぶん一斉に上げるとユーザー全員が落とし直す。** 更新は必要な県だけにすること。

`firestore.rules` に公開読み取りの行が要る（追加済み・デプロイは別途）。

```
match /road_recommend/{id} { allow read: if true; allow write: if false; }
```

## 4. 調整するとき

| 変えたいこと | 場所 |
|---|---|
| 重み（曲率・flow・長さ・道種） | `lib/funSegments.js` の `WEIGHTS` |
| 点数の伸び方 | `lib/funSegments.js` の `NORMALIZERS` |
| 区間の長さ・切り出し方 | `lib/funSegments.js` の `EXTRACT` |
| 対象の道種 | `buildRoadRecommend.js` の `TARGET_HIGHWAYS` |
| 配信するポリラインの粗さ | `buildRoadRecommend.js` の `OUTPUT_TOLERANCE_METERS` |
| 1県あたりの件数 | `--top`（既定150） |

⚠️ **スコアの式はここが「正」。** アプリ側（`RoadCurvinessScorer`）にも似た計算が残っているが、
そちらは配信が取れなかった県の受け皿でしかない。2か所で同じ式を維持すると必ずずれるので、
**アプリ側は直さない**。

## 5. いまの限界

- **ビーナスラインが118位**。29.9km・曲率435と数字は悪くないが、あの道の価値は見晴らしで、
  標高も景観もデータに無い。手動キュレーション層（`docs/road-weighting.md`）で持ち上げる想定。
- `popularity`（走行実績）は重み0.15の枠だけで **0固定**。Cloud Functions での集計が要る。
- `city` が無いので、区間の表示は県名までになる。

## 6. 手直しの画面（road-builder）

```bash
node server.js     # → http://127.0.0.1:4317/roads
```

### 画面の構成

左＝一覧 ／ 中＝地図 ／ 右＝編集パネル（常に見える）。

- **絞り込み** … 道路名で検索、「すべて／調整済み／非表示」で切り替え、点数・長さ・曲率・名前で並べ替え
- **地図** … その県の150区間すべてを描く。選択中は橙、押し上げ済みは緑、非表示は灰色。
  線をクリックしても選べる
- **キーボード** … <kbd>↑</kbd><kbd>↓</kbd> で選択を移動、<kbd>S</kbd> で保存
- 未保存の件数がヘッダに出る。保存せずに県を切り替えようとすると確認が入る

### 区間の手直し

行か地図の線を選ぶと、右のパネルで手直しできる。

| できること | 効果 |
|---|---|
| **点数の加算** | −10 / −5 / ＋5 / ＋10 のボタンか直接入力。ビーナスラインは +15 で118位→1位になった |
| **表示名** | OSM の名前が実感と違うとき（湯河原箱根線 → 椿ライン）。元の名前は残る |
| **ひとこと説明** | アプリの一覧に1行で出る |
| **札** | 絶景／ワインディング／快走／林道ぎみ／要注意 から選ぶか自由入力。アプリには2つまで出る |
| **一覧から外す** | 曲がってはいるが走って面白くない道を消す |

変更はその場で一覧と地図に反映される（保存はしない）。「保存」で
`data/road-overrides/<romaji>.json` に書かれる。
**⚠️ 保存しただけでは配信に反映されない。** `--build` → `--commit` まで回すこと。

調整は**道路名と場所**で紐づけてある（並び順の id ではない）。重みを変えて順位が動いても、
区間の切り出しが 3km 程度ずれても追随する。どの区間にも当たらなくなった調整は
一覧の上に警告が出て、まとめて削除できる。

### 重みの試算

スライダーで重みを動かすと、その県の上位40件がどう入れ替わるかが即座に出る
（`data/road-tuning/*.json` を使うので再生成は不要）。「合計を1.0にそろえる」で
重みの合計を戻せる。

例: curviness 0.35→0.10 / flow 0.25→0.50 にすると、栃木の上位40のうち32件が入れ替わる。

**⚠️ この画面から重みは保存しない。** 採用するときは `lib/funSegments.js` の `WEIGHTS` を
書き換えて `--build` を回す。画面から勝手に変えられると、配信済みのデータと
食い違ったまま気付けなくなるため。

### 触るときの注意

`road-builder.html` の `overrideKey()` と `lib/roadOverrides.js` の `overrideKey()` は
**同じ式でなければならない**。ずれると保存した調整が生成時に当たらず、
エラーも出ないまま「調整したのに反映されない」という形で出る。
`test/keyParity.test.js` が両者を突き合わせているので、片方を直したら必ず `node --test test/` を回すこと。
