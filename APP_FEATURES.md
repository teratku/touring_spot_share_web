# biketeilen 機能まとめ（Webサイト制作用 / Feature Reference）

> ツーリングの「記録・発見・共有・実績」をひとつにまとめた、ライダー向けiOSアプリ。
> 本ドキュメントは、今後のWebサイト（LP / 紹介サイト）制作時の情報設計の指標として、
> 現行アプリに実装されている機能を整理したものです。

- **アプリ名（内部）**: biketeilen / touringSpotShare
- **Bundle ID**: `com.biketeilen.biketeilen-firebase`
- **プラットフォーム**: iOS（iOS 16.0以降、一部機能は16.4以降）
- **対応言語**: 日本語 / English（端末設定に応じて自動切替）
- **最終更新**: 2026-06

---

## 1. アプリ概要（コンセプト）

| 項目 | 内容 |
|------|------|
| 一言で | 走った道を記録し、好きなスポットを発見・共有し、走破実績を貯めるツーリングアプリ |
| 主なターゲット | バイク／ツーリングを楽しむライダー、道の駅・絶景スポット巡りが好きな人 |
| 提供価値 | ①GPSルート記録 ②スポット投稿・共有 ③道路走破率の可視化 ④バッジ・実績によるゲーミフィケーション |
| 収益モデル | サブスクリプション（Plus / Pro）＋ 広告（無料プラン） |

---

## 2. 画面構成（5つのメインタブ）

アプリは下部5タブで構成されています。

| # | タブ | 役割 | 主な機能 |
|---|------|------|----------|
| 0 | **発見** (Discover) | スポットを探す | 地図／リスト切替、検索、スポット閲覧・投稿 |
| 1 | **プラン** (Plan) | ツーリング計画 | スポットを組み合わせたツーリングプランの作成・管理 |
| 2 | **記録** (Record) | ルート記録（中心機能） | GPSによる走行記録、保存、ルート図鑑 |
| 3 | **実績** (Achievements) | 達成の可視化 | バッジ／都道府県制覇／統計／道の駅／道路走破率 |
| 4 | **マイページ** (My Page) | ユーザー管理 | プロフィール、投稿・ルート履歴、設定 |

---

## 3. 機能詳細

### 3-1. ルート記録（コア機能）
- GPSによる走行ルートのリアルタイム記録（バックグラウンド記録対応）
- 走行距離・所要時間・経路を自動計測
- **道路名の自動取得**（OpenStreetMapデータを利用）
  - 自転車道・歩道など車が走行しない道は道路名検索から除外
- **セグメント管理**：道路名ごとに走行区間を分割・編集
- **標高（Elevation）データ**の記録
- **マーカー／スポット写真**：ルート上の任意地点に写真を紐付け（Exifの位置情報抽出に対応）
- 記録後の保存・トリミング・タイトル付け
- ローカル保存（CoreData）＋ JSONファイル（route / markers / segments / elevation）管理
- **サーバーバックアップ／復元**（Plus以上）
- データ修復ユーティリティ（重複ポイント除去・JSON再生成・バックアップ復元）

### 3-2. スポット投稿・発見（Discover）
- 写真付きスポット投稿（複数枚画像、コメント、タグ）
- 住所（都道府県・市区町村）／緯度経度の自動付与
- **地図表示／リスト表示の切替**
- スポット検索
- **道の駅（Michi-no-eki）スポット**の専用対応（全国データ）
- **クチコミ・評価（Word of Mouth）**：星評価付きレビュー、評価数の集計
- ブロック／通報機能（健全性担保）

### 3-3. ツーリングプラン（Plan）
- 複数スポットを組み合わせたツーリングプランの作成
- プランの編集・管理（スポット追加／削除）
- プラン詳細画面
- 無料は作成数に制限、**Plus以上で無制限**

### 3-4. 道路走破率 / ロード図鑑（RoadDex）
- 走った道路をグリッド単位で集計し、**走破率を可視化**
- 地図上に走破済みの道路をハイライト表示（Google Map的な広範囲表示・先読み・タイルキャッシュで高速化）
- フルマップ表示、走破率の達成セレモニー演出
- **Pro限定**：より細かいメッシュ単位での全国制覇可視化
- OpenStreetMap由来データを使用（ライセンス・帰属表示あり）

### 3-5. 実績・バッジ（Achievements）
ゲーミフィケーション要素。獲得時にポップアップ表示・SNS共有可能。

| カテゴリ | 例 |
|----------|----|
| 走行距離 | 10 / 50 / 100 / 200 / 500 / 1000km 走破 |
| ルート数 | 5 / 10 / 20 / 30 / 50 / 100 ルート達成 |
| スポット投稿 | 5 / 10 / 20 / 30 / 50 / 75 / 100 件投稿 |
| 都道府県制覇 | 1 / 5 / 10 / 20 / 47都道府県 |
| 道の駅訪問 | 5 / 10 / 25 / 50 / 100 駅訪問 |
| 連続記録 | 7日連続 / 30日連続 |
| 時間帯 | 早朝（6時前）/ 夜間（21時以降）の記録 |
| Pro特典 | Pro限定バッジ（Pro ライダー 等） |

### 3-6. 都道府県制覇
- 訪問済み都道府県を地図で可視化（47都道府県）
- スポット投稿・ルート記録から自動判定

### 3-7. 統計ダッシュボード
- 走行距離・時間・ペースの集計
- **Plus**：月別の距離・時間トレンド、ペース分析
- **Pro**：速度・標高・燃費などの詳細分析

### 3-8. ルート共有（Share Route）
- 記録したルートを他ユーザーへ共有
- **公開範囲の設定**（プライバシーエディタ）
- 共有ルートの編集・詳細表示
- 共有リンク（ディープリンク）対応

### 3-9. ユーザー・アカウント
- メールアドレス／パスワードによる会員登録・ログイン（Firebase Auth）
- プロフィール（アイコン画像・ユーザー情報）編集
- パスワード変更／メールアドレス変更
- アカウント退会（削除予約）
- 他ユーザーのブロック／通報、ブロックリスト管理

---

## 4. 料金プラン（Free / Plus / Pro）

サブスクリプション（月額・年額、StoreKit経由）。**ファミリー共有はProのみ最大5人**。

| 機能 | Free | Plus | Pro |
|------|:----:|:----:|:---:|
| スポット投稿 | 制限あり（投稿数・500m制限・画像枚数） | 無制限（画像無制限・500m制限緩和） | ✅ |
| 保存機能 | 制限あり | 無制限保存 | ✅ |
| リスト（選択スポット）数 | 制限あり | 無制限 | ✅ |
| 広告 | 表示あり | **非表示** | 非表示 |
| ルート記録 | 月10ルート／90日保持 | **無制限・永久保存** | ✅ |
| ツーリングプラン作成 | 制限あり | 無制限 | ✅ |
| 道の駅DBダウンロード | 広告視聴が必要 | 広告なしで取得 | ✅ |
| サーバーバックアップ | ― | ✅ | ✅ |
| 統計 | 基本のみ | 月別トレンド・ペース分析 | **詳細分析（速度・標高・燃費）** |
| 道路走破率 | ― | ― | ✅（**メッシュ単位の細かい可視化**） |
| GPX / CSV エクスポート | ― | ― | ✅ |
| オフライン地図キャッシュ | ― | ― | ✅ |
| Pro限定バッジ | ― | ― | ✅ |
| ファミリー共有 | ― | ― | ✅（最大5人） |

> ※ 無料プランでは、報酬型広告（リワード広告）を視聴することで一部機能を一時解放できる導線あり。

---

## 5. その他の機能・特徴

- **多言語対応**：日本語 / 英語（端末の言語設定に追従）
- **広告（AdMob）**：バナー／インタースティシャル／リワード広告（Plus以上で非表示）
- **プッシュ通知**（Firebase Cloud Messaging）
- **お問い合わせ／フィードバック**：問い合わせフォーム、マイクロフィードバック収集
- **コメント機能**（コメントルーム）
- **初回利用ガイド**（記録機能のオンボーディング）
- **アプリレビュー依頼**（適切なタイミングでのレビュー誘導）

---

## 6. 技術基盤（参考・Web連携の検討材料）

| 領域 | 採用技術 |
|------|----------|
| UI | SwiftUI（一部UIKit） |
| 認証・DB・ストレージ | Firebase（Auth / Firestore / Storage / Messaging） |
| 地図 | Google Maps SDK / MapKit |
| ローカル永続化 | CoreData（Route / RoutePoint / SpotPhoto）＋ JSON ＋ SQLite（道路データ） |
| 課金 | StoreKit（サブスクリプション） |
| 広告 | Google AdMob |
| 道路データ | OpenStreetMap（帰属表示・ライセンス準拠） |
| 画像 | SDWebImage |

---

## 7. データモデル（主要Firestoreコレクション）

> Web／バックエンド連携時の参照用。**Swiftモデルのプロパティ名と実際のFirestoreフィールド名が異なる**項目があるため、実フィールド名で参照すること。

### 7-1. 評価・クチコミ：`wordOfMouth`

- 定数定義: `firebaseDBName.swift` → `womDBName = "wordOfMouth"`
- 画像Storageパス: `womImages/`
- 書き込み: `locationDetail_review.swift`（`addDocument`） / 読み込み: `firestoreAction.swift`（`insertWOMData`）

| Firestoreフィールド名 | 型 | 内容 | 備考 |
|---|---|---|---|
| （ドキュメントID） | String | レビューの一意ID | 自動採番。`docID` / `review_docID` として利用 |
| `womAssessment` | Int | 星評価（1〜5） | ⚠️ `rating` ではない |
| `postUserID` | String | 投稿ユーザーのUID | ⚠️ `userID` ではない |
| `locationDocID` | String | 対象スポットのドキュメントID（外部キー） | スポットとの紐付け |
| `comment` | String | レビュー本文 | |
| `imageNames` | [String] | 添付画像ファイル名 | 現状の投稿は空配列で登録 |
| `imageURLs` | [String] | 添付画像URL | 同上 |
| `createTime` | Timestamp | 投稿日時 | ⚠️ `createdAt` ではない。`serverTimestamp()` |

> ※ Swiftモデル `womData` の `BlockBool: Bool` は **Firestore非保存**。読み込み時にブロックリストと突き合わせてクライアント側で算出するフラグ。

### 7-2. 評価集計：`wordOfMouthCounter`

スポットごとの平均評価を高速表示するための集計ドキュメント（`returnWOMCounter` で読み取り）。

| Firestoreフィールド名 | 型 | 内容 |
|---|---|---|
| `locationDocID` | String | 対象スポットのドキュメントID |
| `womCounter` | Int | レビュー件数 |
| `sumWOMAssessment` | Int | 評価の合計値（平均 = `sumWOMAssessment / womCounter`） |

### 7-3. フィールド命名の対応表（重要）

| 一般的な想定名 | 実際のFirestoreフィールド名 |
|---|---|
| `rating` | `womAssessment` (Int) |
| `comment` | `comment` ✅ |
| `userID` | `postUserID` (String) |
| `createdAt` | `createTime` (Timestamp) |
| （スポット紐付け） | `locationDocID` (String) |

> 別系統の `reviewData` 構造体はプロパティ名が `rating` / `userID` だが、内部では同じ `womAssessment` / `postUserID` フィールドを読んでいる。プロパティ名に引きずられないこと。

### 7-4. サブスクリプション状態（Free / Plus / Pro）

> ⚠️ **重要**：サブスク状態を保存している専用のFirestoreコレクション／フィールドは**存在しない**。tierは保存値ではなく、**StoreKit（Apple）から実行時に算出**している（`SubscriptionStateManager.refreshEntitlements()`）。

**メモリ上の状態**（`SubscriptionStateManager.shared` の `@Published`、シングルトン保持。永続化されない）:

| プロパティ | 型 | 内容 |
|---|---|---|
| `currentTier` | `SubscriptionTier` | `.free` / `.plus` / `.pro` |
| `currentProductID` | `String?` | 購入中のプロダクトID |
| `subscriptionExpiration` | `Date?` | 有効期限 |
| `lastCheckedAt` | `Date?` | 最終判定時刻 |

**プロダクトID → tier マッピング**:

| StoreKit プロダクトID | 判定tier |
|---|---|
| `biketeilen_pro_monthly` / `biketeilen_pro_yearly` | Pro（最優先） |
| `biketeilen_plus_monthly` / `biketeilen_plus_yearly` | Plus |
| `subscription_3`（旧プロダクト） | Plus 相当（移行互換） |
| （該当なし） | Free |

**判定の優先順位**（上が強い）:
1. 開発者モード（DEBUGのみ）… `UserDefaults` キー `developer_mode_enabled` → Proに上書き
2. `forcedProUserIDs`（`SubscriptionStateManager.swift` 内のハードコードUID集合）→ Pro固定（StoreKitスキップ、`currentProductID = "forced_pro_override"`）
3. StoreKit エンタイトルメント（`Transaction.currentEntitlements` / `Transaction.updates`）
4. `forcedFreeUserIDs`（同ハードコードUID集合）→ Freeへ強制ダウングレード

**Firestore上の唯一の痕跡（tier本体ではない）**:
- Pro検出時に付与される**バッジ** `userInfo/{userID}/badges/pro_member`（フィールド: `name` / `description` / `iconName` / `earnedAt`）
- 一度Proになると付与される記録で、**解約しても消えない**＝現在の課金状態の判定には使えない

**⚠️ Web／バックエンド連携での注意**:
現状、サーバー側からユーザーのプランを知る手段がない（Firestore非保存のため）。Webで会員種別を出し分けるには:
- **(A)** Apple の App Store Server API / Server Notifications でサーバー検証する、または
- **(B)** アプリ側で判定したtierをFirestoreに書き出す設計を追加する（例: `userInfo/{uid}` に `subscriptionTier` / `subscriptionExpiration` フィールド）※現状未実装

---

## 8. Webサイト向け：訴求ポイント案（たたき台）

サイトのセクション構成・キャッチコピーの素案として。

1. **ヒーロー**：「走った道が、地図になる。」— GPSルート記録 × 道路走破率の可視化
2. **記録**：ワンタップで走行を記録。道路名・標高・写真まで自動で残る
3. **発見**：全国のスポット・道の駅を地図で発見、クチコミ付き
4. **実績**：距離・都道府県・道の駅…走るほど貯まるバッジと制覇マップ
5. **共有**：お気に入りのルートを仲間にシェア
6. **プラン比較**：Free / Plus / Pro の3プラン表（上記4章を流用）
7. **多言語**：日本語・英語対応で海外ライダーにも
8. **CTA**：App Store ダウンロードボタン

---

### 補足メモ（サイト制作時の注意）
- 道路データ・地図はOpenStreetMap/Google由来のため、**帰属表示（Attribution）**をサイトにも記載するのが安全
- スクリーンショットは iPhone 6.5″（1242 × 2688）で書き出し予定（App Store素材と共通化可能）
- 「道路走破率（RoadDex）」「メッシュ単位」「GPX/CSVエクスポート」はPro訴求の差別化ポイント
