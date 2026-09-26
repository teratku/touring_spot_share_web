# 配信用のルート生成API。**Valhalla と同じコンテナに入れる。**
#
# ⚠️ **ビルドはリポジトリの根から。** `admin/lib` を複製せずそのまま入れるため。
#      DOCKER_BUILDKIT=0 docker build -f service/Dockerfile -t route-api .
#    ⚠️ `service/` の中でビルドすると `admin/lib` が見えず、
#       判断の中身（規制・案内）を二重に持つはめになる。**必ず根から。**
#
# ⚠️ **`DOCKER_BUILDKIT=0` が要る。** BuildKit は下の `FROM` を Docker Hub に
#    取りに行き、`pull access denied` で落ちる（土台は手元だけにあるイメージなので
#    公開レジストリには無い）。旧ビルダーなら手元のイメージを使う。
#    実測: 土台がある状態で 4分30秒。
#
# ⚠️ **Cloud Run は amd64。** 土台が amd64 なので Apple Silicon でも amd64 で焼ける
#    （`platform does not match` の警告は出るが、それでよい）。
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
# ⚠️ **県の形（87KB）も入れること。** 経路が通る県を決めるのに要る。
#    もとはアプリ側にあるがビルド文脈の外で、忘れると ENOENT で落ちた
COPY admin/data/japan-prefectures.geojson /app/admin/data/japan-prefectures.geojson
# ⚠️ **信号（1.56MB）も入れること。** 入れ忘れると案内が「この交差点で」に
#    ならないだけで**エラーは出ない**（読めなければ信号なしとして動く）
COPY admin/data/traffic-signals.bin /app/admin/data/traffic-signals.bin
# ⚠️ **原付の右折方法の標識と JARTIC の信号**（`admin/buildJarticMopedTurns.js` が作る）。
#    入れ忘れると黙って法の既定だけで決める（二段階右折を言いすぎる）
COPY admin/data/jartic-moped-turns.json /app/admin/data/jartic-moped-turns.json
COPY admin/data/jartic-signals.bin /app/admin/data/jartic-signals.bin
# ⚠️ スマートIC（ETC専用）の料金所。無いと車載器なしの乗り手を黙ってスマートICへ通す（lib/smartIcGates.js）
COPY admin/data/smart-ic-gates.json /app/admin/data/smart-ic-gates.json
# ⚠️ 高速の SA/PA（`admin/buildSapa.js` が作る）。無いと `/v1/sapa` が黙って空を返す
COPY admin/data/sapa.json /app/admin/data/sapa.json
COPY service/package.json /app/service/package.json
RUN cd /app/service && npm install --omit=dev

COPY service/lib       /app/service/lib
COPY service/server.js /app/service/server.js
# ⚠️ **`service/lib` も入れること。** 忘れて `Cannot find module './lib/buildRoute'`
#    で落ちた。server.js だけ入れても中身が無い

# ⚠️ **道路グリッドCSVは入れない。** 道路名の推定（JARTIC 取り込み）でしか使わず、
#    数GBある。配信では要らない。

ENV PORT=8080
ENV VALHALLA_URL=http://127.0.0.1:8002
EXPOSE 8080

# ⚠️ **Valhalla と API の両方を起こすこと。** どちらか片方だと動かない。
#    ⚠️ Valhalla が落ちたらコンテナごと終わらせる（黙って経路が出ない状態にしない）
COPY service/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# ⚠️ **土台の ENTRYPOINT を打ち消すこと。** 土台は
#    `ENTRYPOINT ["/valhalla/scripts/run.sh"]` / `CMD ["build_tiles"]` なので、
#    こちらの CMD は**その引数として渡されるだけ**で start.sh に届かない。
#    実際に Cloud Run で落ちた:
#      「If you run with custom UID or GID you have to create the mapped
#        directory to the container's /custom_files」→ Container called exit(1)
#    土台の run.sh はタイルを焼くための入口で、配信では通らない。
ENTRYPOINT []
CMD ["/app/start.sh"]
