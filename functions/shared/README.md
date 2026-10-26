# functions/shared

関数（Cloud Functions）からも使う部品の**写し**。関数のフォルダの外は配信に入らないので、ここに写して置く。

| 写し | 元 |
|---|---|
| `roads-lib.js` | `public/roads-lib.js`（おすすめ道路のまとめ方・道の鍵） |
| `roadPaceCalc.js` | `admin/lib/roadPaceCalc.js`（走りの速さの計算。アプリの RoadPace の写し） |

⚠️ 元を直したら写し直す（`service/test/functionsShared.test.js` が中身が同じかを見ている）:

```bash
cp public/roads-lib.js functions/shared/roads-lib.js && cp admin/lib/roadPaceCalc.js functions/shared/roadPaceCalc.js
```
