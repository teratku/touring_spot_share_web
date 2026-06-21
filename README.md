# touring_spot_share_web 操作・運用ガイド

iOSアプリ `biketeilen` のコンパニオン Web（**Firebase Hosting + Cloud Functions**、同一 Firestore を共有）。
- **何をするWebか**（役割・仕様）→ [`WEB_APP_SPEC.md`](WEB_APP_SPEC.md)
- **スタンプラリーの管理ツール（ローカル作成サーバ/ビルダー/投入スクリプト）** → [`admin/README.md`](admin/README.md)
- 本書は **どう動かす・直す・公開するか（運用）** を扱う。

---

## 0. 準備
```bash
npm install -g firebase-tools      # 初回のみ
firebase login                     # 初回のみ
# プロジェクト: biketeilen（firebase.json と同ディレクトリで実行）
```

---

## 1. ローカルで動かす
公開サイトは `public/` 配下の静的ページ。ローカル配信：
```bash
cd touring_spot_share_web
firebase serve --only hosting          # もしくは firebase emulators:start
# 表示されたURLを開く（例: http://127.0.0.1:5002/ ）
#   ページ例: /user.html?id=<uid> , /index.html , /touring-plan.html ...
```
> `file://` で直接開くと Firebase/Maps が動かないため、必ずローカルサーバ経由で。

---

## 2. デプロイ（公開）
```bash
firebase deploy --only hosting                 # 静的サイト（public/）
firebase deploy --only functions               # Cloud Functions（functions/・Node 24）
firebase deploy                                 # まとめて
```
- Hosting キャッシュ: 画像/js/css は長期 immutable、html は1時間、`sw.js` は no-cache（`firebase.json` の headers）。
- リライト: `/blog/blog-detail.html` → 関数 `blogSSR`、`/blog/blog-editor.html` → `/index.html`。

---

## 3. ページ構成（public/）
| ページ | 役割 |
|---|---|
| `index.html` | トップ（スポット発見・地図） |
| `detail.html` | スポット詳細（`?id=`） |
| `user.html` | ユーザー詳細（`?id=<uid>`）。投稿/ルート/**スタンプラリー**表示 |
| `routes.html` / `route-detail.html` | ルート一覧 / 詳細 |
| `touring-plan.html` | ツーリングプラン作成・編集（Web中核機能） |
| `plan-suggest.html` | おまかせ提案（現在地から距離/方角でスポット提案→プラン化） |
| `login.html` | ログイン（既存アカウントのみ。新規登録はiOS） |
| `about.html` / `support.html` | アプリ紹介 / サポート |
| `ogp.html` | OGP画像生成用（1200×630） |
| `spot-pickup.html` | ローカル限定の作業ページ |
| `404.html` | NotFound |
| `menu.js` / `sw.js` | 共有メニュー / Service Worker（PWA・キャッシュ） |

- Firebase 設定（apiKey 等）は各 HTML 内にインライン初期化。フロントは Vue3 + Firebase **compat** SDK。

---

## 4. スタンプラリーの Web 表示（user.html）
iOS で「スタンプ帳をWeb公開」を ON にしたユーザーのみ、`user.html` に年度別の獲得数を表示する。

- データ源: `user_stats/{uid}`
  - `stampRallyPublic`（bool）… 公開フラグ（iOSのトグルが書く）
  - `stampSummary`（map）… 年度→獲得数（iOSが付与時/公開時に集計して書く）
- 動作（`loadStampSummary()`）: `stampRallyPublic === true` のとき「🔰 スタンプラリー」セクションに `{年度}年度 {個数}個` のチップを表示。公開OFF/データ無しは非表示。
- 確認: アプリでトグルON → `user.html?id=<自分のuid>` を開く。

> 前提: Firestore ルールで `user_stats/{uid}` の **公開読取**＋**本人書込**、`stampRallies` の公開読取が必要（未整備だと表示/書込が拒否）。詳細は `touringSpotShare/STAMP_RALLY_DESIGN.md` §12-5。

---

## 5. Cloud Functions（functions/）
```bash
cd functions
npm install
npm run serve     # emulators（functions のみ）
npm run deploy    # firebase deploy --only functions
npm run logs      # ログ
```
- 例: `blogSSR`（ブログ詳細のSSR・hosting rewrite から呼ばれる）。Node 24。

---

## 6. よくある操作
- **画像追加**: `images/`（OGP等）。Hosting で長期キャッシュされるためファイル名を変えると確実に更新。
- **PWA更新が反映されない**: `sw.js` は no-cache 設定。再読込（ハードリロード）で更新。
- **スタンプ表示が出ない**: ①トグルON済みか ②`?id=` が本人uidか ③Firestoreルール（§4参照）。

---

## 7. リポジトリ内ドキュメント
- [`WEB_APP_SPEC.md`](WEB_APP_SPEC.md) … Web の役割・現状・不足機能・目標仕様
- [`APP_FEATURES.md`](APP_FEATURES.md) … iOSアプリの全機能
- [`admin/README.md`](admin/README.md) … スタンプラリー 管理ツール（ビルダー/生成器/投入/状態管理）
- iOS: `touringSpotShare/STAMP_RALLY_DESIGN.md` … スタンプラリー設計（§11〜§13）

---

## 8. 注意
- 本番 `biketeilen` プロジェクトに公開・読み書きします。デプロイ前に `firebase serve` で確認。
- 新規会員登録・スポット投稿・GPS記録は **Webでは行わない**（iOSの役割）。
- 管理ビルダー（`admin/server.js`）は **公開しない**ローカル専用（Hosting には含めない）。
