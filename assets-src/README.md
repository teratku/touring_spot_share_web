# サイトの画像の元ファイル（配信しない）

`public/` の外に置いた元画像。サイトには WebP にしたものを出す（2026-10-07・利用者のメモ「サイトの画像を WebP にする」）。

| 元 | 出すもの | 作り方 |
|---|---|---|
| `screens/screen-*.png`（1320×2868） | `public/images/screen-*.webp`（横690） | `cwebp -q 85 -resize 690 0 screens/screen-plan.png -o ../public/images/screen-plan.webp` |
| `public/images/ogp-bg.jpeg`（5712×4284） | `public/images/ogp-bg.webp`（横2400・about の背景） | `cwebp -q 78 -resize 2400 0 ../public/images/ogp-bg.jpeg -o ../public/images/ogp-bg.webp` |

- ⚠️ 画面の画像は about の電話の枠（幅およそ226px）に出すので、3倍の高精細でも横690で足りる
- ⚠️ `ogp.png`・`ogp-bg.jpeg`・アイコン・ラリーの画像（`images/rallies/*.jpg`）は**形式を変えない**。
  SNS の共有画像は WebP を読めないところがあり、アイコンは決まった形式、ラリーの画像はアプリが `.jpg` の名前で読みに来る。
  `ogp-bg.jpeg` は OGP 画像を作る `ogp.html` が使うので残す
