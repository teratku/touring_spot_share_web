# 運営用：スタンプラリー マスタ投入

スタンプラリーの定義（`stampRallies/{rallyId}`）を JSON から Firestore へ投入するフロー。
設計の詳細は iOS リポジトリの `STAMP_RALLY_DESIGN.md` を参照。

## 構成
```
admin/
  importRallies.js          # 検証→Firestore へ merge upsert
  package.json
  rallies/
    2025/                    # 年度フォルダ（fiscalYear と一致させる）
      michinoeki-tohoku-2025.json   # 1ラリー = 1ファイル
```

## 初回セットアップ
```bash
cd admin
npm install
```

### 認証（どちらか）
- **a) gcloud ADC（推奨・鍵ファイル不要）**
  ```bash
  gcloud auth application-default login
  ```
- **b) サービスアカウント鍵**：Firebase コンソール → プロジェクト設定 → サービスアカウント → 新しい秘密鍵を生成 → `admin/serviceAccount.json` に保存（`.gitignore` 済み）。

## 投入フロー
```bash
# 1) JSON を作成/編集（rallies/2025/<rallyId>.json）
# 2) まず検証（書込みなし・安全）
node importRallies.js --year 2025 --dry-run
# 3) 問題なければ投入（本番Firestoreに書込み）
node importRallies.js --year 2025
# 単一ファイルだけ投入する場合
node importRallies.js --file rallies/2025/michinoeki-tohoku-2025.json
```
- `--dry-run`：全件を検証するだけ（1件でも不正なら中断＝部分投入を防ぐ）。
- 投入は `set(..., { merge: true })`。**改訂も同じスクリプトで反映**（既存フィールドを保ちつつ更新）。

## JSON スキーマ（1ラリー）
| キー | 必須 | 説明 |
|---|---|---|
| `rallyId` | ✓ | 一意ID。ファイル名と揃えると管理しやすい |
| `name` / `theme` | ✓ | 表示名 / テーマ（michinoeki, scenery, onsen…） |
| `fiscalYear` | ✓ | 年度（整数）。**フォルダ名 `--year` と一致必須** |
| `startAt` / `endAt` | ✓ | ISO8601（例 `2025-04-01T00:00:00+09:00`）。`startAt < endAt` |
| `targets[]` | ✓ | 対象スポット配列（1件以上） |
| `region` / `description` / `coverImageURL` | 任意 | |
| `rewardBadgeId` / `completionTitle` | 任意 | 完了報酬 |

### target
| キー | 必須 | 説明 |
|---|---|---|
| `targetId` | ✓ | ラリー内で一意。**年度内で変更しない**（変更するとユーザーのスタンプ紐付けがズレる） |
| `name` | ✓ | スポット名 |
| `lat` / `lng` | ✓ | 緯度経度（チェックインのGPS検証に使用） |
| `order` | 任意 | 表示順（無ければ配列順） |
| `spotId` | 任意 | 既存スポット（`locationDBName` / `MicinoEki` の docID）。あると重複データを避けられる |
| `address` / `imageURL` | 任意 | |

## 年度切替
新年度フォルダ（例 `rallies/2026/`）に JSON を足して `--year 2026` で投入するだけ。
**過去年度のマスタは削除しない**（ユーザーの過去スタンプ閲覧のため読取可のまま）。

## 注意
- 本番 `biketeilen` プロジェクトに書き込みます。必ず `--dry-run` で検証してから。
- 公開前にテスト用 uid でアプリ表示・チェックイン・写真付与を確認。
- `_note` などアンダースコア始まりのキーは投入時に無視されます（メモ用）。
