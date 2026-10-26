# The PhoneMote server for coms.kw.ac.kr/phonemote (ARCHITECTURE.md D63):
# the web build's files, signaling and the relay, in one small container.
# Build from the repository root: docker compose -f deploy/coms/compose.yaml up -d --build

FROM node:24-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@11.24.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:web && pnpm --filter @phonemote/server bundle:cloud

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4190 PHONEMOTE_HOST=0.0.0.0 PHONEMOTE_WEB_DIR=/app/web
COPY --from=build /src/apps/server/dist/cloud.cjs ./cloud.cjs
COPY --from=build /src/apps/game/dist/web ./web
USER node
EXPOSE 4190
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4190/health || exit 1
CMD ["node", "cloud.cjs"]
