# ナビゲーション & AIルート生成 設計方針（NAV_AI_ROUTE_SPEC）

> ステータス：**方針スペック（着手前）**。iOSアプリ中心の技術方針を定める設計書。
> 関連：[APP_FEATURES.md](APP_FEATURES.md)（アプリ機能）／[WEB_APP_SPEC.md](WEB_APP_SPEC.md)（Web/プラン）。
> 最終更新：2026-06

## 1. 目的（何を作るか）
iOSアプリ「ツーリングスポットシェア」に、次を段階的に追加する：
1. **ターンバイターン式ナビ**（音声＋画面の道案内）
2. **おすすめ道路の紹介**（走って気持ちいい道）
3. **パーソナライズ提案**（走破履歴などから「走りそうな道」）
4. **AIによるルート決定**

本書は **iOSアプリ中心の方針**。アプリ本体は別リポジトリ（`biketeilen_iOS_clean`）のため、ここでは
アーキテクチャ・技術選定・段階計画・**データ契約**を定める。本リポジトリ（Web＋Functions）に入るのはバックエンドの一部のみ。

### 確定事項
| 項目 | 決定 |
|---|---|
| 対象 | **iOSアプリ中心**の方針設計 |
| 経路エンジン | **OSM系（GraphHopper 推奨 / OSRM 代替）を自ホスト** |
| Phase 1 最優先 | **AIルート生成**（入力＝自然言語 or 好み条件） |
| AIの中身 | **別途決定** → 入出力契約を固定した**差し替え可能レイヤ**として設計 |

## 2. 方針の核：AIと経路計算の責務分離
```
ユーザー入力（自然文 or 好み条件フォーム）
  └─▶ AIルート解釈レイヤ（差し替え可能・配置想定 Cloud Functions）
        ・自然文/好みを RouteSpec（構造化条件）へ正規化
        ・テーマ → 経由候補（スポット/道路）を選定
  └─▶ 経路エンジン（GraphHopper / OSRM）
        ・RouteSpec＋経由地 → 実道路ジオメトリ＋ターン指示を計算
  └─▶ アプリ：ルート描画 →（後期）ターンバイターン開始
```
- **AI＝「どこを・何を」（intent → RouteSpec＋経由地）**／**経路エンジン＝「どの道を・どう曲がるか」**。
- AI内部が未定でも、`RouteSpec` 契約さえ守れば後から差し替え可能。

## 3. 技術選定
### 経路エンジン：GraphHopper 推奨（OSRM 代替）
- **GraphHopper**：`custom_model`（曲がりの多い道・絶景優先・高速回避・二輪重み）、`round_trip`（周回）、`alternative_route` に標準対応 → 「気持ちいい道」「日帰り周回」に直結。
- **OSRM**：高速・単純だがコスト関数のカスタムが弱く enjoyable-road 重み付けに不向き。まず GraphHopper、性能課題が出たら併用検討。
- データ：Geofabrik `japan-latest.osm.pbf`（RoadDex も OSM 由来で系譜一致）。
- ホスティング：Docker（Cloud Run もしくは VPS）。叩くのは route / round_trip / custom_model。

### AIレイヤ：契約優先・差し替え可能（配置想定 Cloud Functions × Claude API）
- プロバイダ/プロンプトは別途決定。**入出力契約を先に固定**し内部を隠蔽。
- 配置候補：本リポジトリ `functions/`（現状 `firebase-admin`/`firebase-functions`・`blogSSR` のみ）にHTTP/Callableを1本追加。Claude採用時はプロンプトキャッシュ前提。

## 4. データ契約：`RouteSpec`（Phase 1 で最初に固める）
AIレイヤの出力＝経路エンジンへの入力。自然文入力・好み条件入力は**どちらもこの形に正規化**（入口が違うだけ）。
```jsonc
{
  "origin": { "lat": 0, "lng": 0 },        // 現在地など（必須）
  "destination": { "lat": 0, "lng": 0 },   // null = 周回(round trip)
  "isLoop": false,
  "targetDistanceKm": 200,
  "roadPrefs": { "winding": 0.8, "scenic": 0.7, "avoidHighway": true, "avoidTraffic": 0.5 },
  "themes": ["michinoeki", "onsen", "zekkei"],
  "mustVisitSpotIds": ["<imagedownload docId>"],
  "seasonHints": ["summer"]
}
```
- 経由地解決：`themes`/`roadPrefs` を既存データにマップ（`imagedownload` スポット、admin `prefecture-recommend`、Phase2「おすすめ道路」シード）。

## 5. 既存資産の再利用（本リポジトリ）
- `public/plan-suggest.html`（おまかせ提案＝半径/方角でスポット提案）→ **経由地解決・好み入力UX** の下敷き。
- `public/touring-plan.html` の経路サマリー（Google Directions＋直線フォールバック）→ ルート描画・距離/所要提示のパターン。
- Firestore：`shared_routes`（走行済みGPS track＝人気道路シグナル）／`road_completion`（RoadDex＝パーソナライズ＋OSM系譜）／`imagedownload`（スポット）／admin `prefecture-recommend`（キュレーション）。
- OSM（Geofabrik Japan）＝ルーティンググラフ＋道路属性。

## 6. 段階計画
- **Phase 1（最優先）AIルート生成** … GraphHopper（＋日本OSM）起動 → `RouteSpec` 契約確定 → AIレイヤ（自然文/好み→RouteSpec→経由地）→ 経路エンジンで実ルート化。アプリ成果＝AIルートを地図に描画（初期は静的表示＋既存ナビ/Googleマップ委譲でも可）。
- **Phase 2 おすすめ道路の発掘** … 道路セグメントをスコアリング（OSM属性の曲率・等級・路面 ＋ `shared_routes` map-match 人気度 ＋ `prefecture-recommend`）→ GraphHopper `custom_model` 重み＋「道路紹介」一覧。
- **Phase 3 パーソナライズ提案** … `road_completion`（未走破近傍）＋過去 `shared_routes`（平均距離・好む道種）から嗜好推定。
- **Phase 4 ターンバイターンナビ本体（アプリ）** … GraphHopper のターン指示描画＋音声（`AVSpeechSynthesizer`）、オフルート検知→再計算、バックグラウンド位置（アプリ既存のGPS記録基盤を流用）。ナビUXのみ Mapbox Navigation SDK も選択肢（経路計算はOSM固定）。

## 7. 本リポジトリで触る候補（アプリ外の部分）
- `functions/`：AIルート生成エンドポイント（HTTP/Callable）＋ AI SDK依存＋ `RouteSpec` バリデーション。
- 経路エンジンは別インフラ（Docker）。設定/デプロイ手順は 新規 `routing/` にドキュメント化。
- ※ ナビUI・音声・地図・再計算などアプリ本体は別リポジトリ（本書は仕様提供）。

## 8. 未確定・要決定（実装前に詰める）
- **AIプロバイダ/プロンプト**（別途決定）→ 契約優先で先行。
- **経路エンジンのホスティング/コスト**（自ホストOSM＝運用負荷 vs Cloud Run）。
- ナビUXを自作するか Mapbox Nav SDK か（経路はOSM固定）。
- OSMライセンス表示（ODbL・帰属）— RoadDex で既に対応済みの方針を踏襲。

## 9. 検証（どうテストするか）
- 経路エンジン：`curl` で GraphHopper に日本のA→B・round_trip・custom_model を投げ、polyline＋turn instructions＋距離を確認。
- AIレイヤ：自然文/好み → `RouteSpec` のスキーマ検証（JSON Schema）＋ゴールデンケース（例「海沿い・絶景・200km・日帰り」→ 期待条件）。
- E2E：アプリ（別リポジトリ）→ AIエンドポイント → 経路エンジン → 地図描画。目標距離との誤差を測定。
- 本リポジトリ分（Functions/エンジン設定）はローカル単体検証。アプリ本体は別リポジトリで結合検証。
