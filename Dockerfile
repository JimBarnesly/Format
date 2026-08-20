FROM node:22-alpine

RUN apk add --no-cache ffmpeg && mkdir -p /music /cache /data

WORKDIR /app
ENV MUSIC_ROOT=/music CACHE_DIR=/cache DATA_DIR=/data
COPY . .
CMD ["node", "server.mjs"]
