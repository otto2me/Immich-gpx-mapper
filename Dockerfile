FROM node:26-alpine AS build
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}
WORKDIR /app

COPY package.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm install

COPY backend backend
COPY frontend frontend
RUN npm run build
RUN npm prune --omit=dev

FROM node:26-alpine AS runtime
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont \
    && ln -s "$(command -v chromium-browser || command -v chromium)" /usr/local/bin/komoot-chromium
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    CONFIG_FILE=/data/config.json \
    STATIC_DIR=/app/public \
    KOMOOT_CHROMIUM_PATH=/usr/local/bin/komoot-chromium
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/build ./public

EXPOSE 3000
VOLUME ["/data"]
USER node
CMD ["node", "backend/dist/server.js"]
