FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
CMD ["node", "server.mjs"]
