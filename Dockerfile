FROM node:22-bookworm-slim

ARG SPOTIFLAC_VERSION=0.7.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
  && pip3 install --break-system-packages --no-cache-dir "SpotiFLAC==${SPOTIFLAC_VERSION}" \
  && mkdir -p /music /cache /data \
  && chown -R node:node /music /cache /data \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV MUSIC_ROOT=/music CACHE_DIR=/cache DATA_DIR=/data
COPY --chown=node:node . .
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "const port=process.env.PORT || \"4534\"; fetch(`http://127.0.0.1:${port}/api/bootstrap`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
