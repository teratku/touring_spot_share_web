#!/usr/bin/env bash
# コールドスタートを測る。
#
# ⚠️ **`min-instances 0` で使えるかの判断材料。** 4.5GB のイメージを Cloud Run が
#    引く時間が唯一の未確認だった。結果で 0 / 1 が決まり、月額が変わる。
#
# ⚠️ **デプロイや `services update` で冷やさないこと。** どちらも完了前に
#    ヘルスチェックが走り、**インスタンスが温まった状態で終わる**。
#    冷えた状態は「無通信でしばらく置く」でしか作れない（既定で約15分）。
set -e
REGION=asia-northeast1
SERVICE=route-api
TIMES=${1:-3}
IDLE=${2:-960}          # 冷えるまで待つ秒数（既定16分）

URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
[ -n "$URL" ] || { echo "サービスが見つかりません: $SERVICE"; exit 1; }
echo "計測先: $URL"
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

i=1
while [ "$i" -le "$TIMES" ]; do
  echo "[$(date +%H:%M:%S)] ${IDLE}秒 待って冷やします（$i/$TIMES）"
  sleep "$IDLE"

  TOKEN=$(gcloud auth print-identity-token)
  S=$(ms)
  CODE=$(curl -s -o /tmp/cold_body.txt -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" --max-time 300 "$URL/health")
  E=$(ms)
  COLD=$(( E - S ))

  # ⚠️ すぐ次を測って、温まった状態との差を出す
  S2=$(ms)
  curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" --max-time 60 "$URL/health"
  E2=$(ms)

  echo "[$(date +%H:%M:%S)] $i 回目  冷: ${COLD}ms  温: $(( E2 - S2 ))ms  HTTP $CODE"
  i=$((i + 1))
done
