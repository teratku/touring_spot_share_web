#!/usr/bin/env bash
# Valhalla と API を両方起こす。
# ⚠️ **どちらかが落ちたらコンテナごと終わらせる。** 片方だけ生きていると
#    「繋がるのに経路が出ない」状態になり、Cloud Run が異常に気づけない。
#
# ⚠️ **`#!/bin/sh` にしないこと。** 下の `wait -n` は bash 専用で、Debian の
#    `/bin/sh`（dash）では `wait: Illegal option -n` で落ちる。
#    実際に Cloud Run で落ちた（Valhalla は起動済み・/status も 200 だったのに
#    この1行でコンテナごと終了した）。
#    ⚠️ `kill -0` のポーリングで代用しないこと。終了した子はゾンビとして残り、
#       `kill -0` が成功し続けるので**落ちたことを検知できない**。
set -e

valhalla_service /custom_files/valhalla.json 1 &
VALHALLA_PID=$!

# ⚠️ Valhalla が起き切る前に API が来ると 502 になる。待つ
i=0
while [ $i -lt 120 ]; do
  if curl -sf "http://127.0.0.1:8002/status" > /dev/null 2>&1; then break; fi
  sleep 1
  i=$((i + 1))
done

node /app/service/server.js &
API_PID=$!

wait -n "$VALHALLA_PID" "$API_PID"
exit $?
