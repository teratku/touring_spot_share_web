# 配信用のルート生成API。**Valhalla と同じコンテナに入れる。**
#
# ⚠️ **ビルドはリポジトリの根から。** `admin/lib` を複製せずそのまま入れるため。
#      docker build -f service/Dockerfile -t route-api .
#    ⚠️ `service/` の中でビルドすると `admin/lib` が見えず、
#       判断の中身（規制・案内）を二重に持つはめになる。**必ず根から。**
#
# ⚠️ **土台は焼き済みの Valhalla イメージ**（タイル入り・4.15GB）。
#    タイルはイメージに焼くしかない（惑星規模を実行時に落とせない）。
FROM valhalla-jp-cloudrun:amd64

USER root

# ⚠️ node は土台に入っていない。入れる
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ⚠️ **判断の中身は admin/lib のものをそのまま使う。** 複製しない
COPY admin/lib            /app/admin/lib
COPY admin/package.json   /app/admin/package.json
COPY service/package.json /app/service/package.json
RUN cd /app/service && npm install --omit=dev

COPY service/server.js /app/service/server.js

# ⚠️ **道路グリッドCSVは入れない。** 道路名の推定（JARTIC 取り込み）でしか使わず、
#    数GBある。配信では要らない。

ENV PORT=8080
ENV VALHALLA_URL=http://127.0.0.1:8002
EXPOSE 8080

# ⚠️ **Valhalla と API の両方を起こすこと。** どちらか片方だと動かない。
#    ⚠️ Valhalla が落ちたらコンテナごと終わらせる（黙って経路が出ない状態にしない）
COPY service/start.sh /app/start.sh
RUN chmod +x /app/start.sh
CMD ["/app/start.sh"]
