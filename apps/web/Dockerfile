# The web image: the single-page app and the small Node
# server that serves it. The URLs come from the container's environment at
# start (NUXT_PUBLIC_*), not from the build. Build from the repository
# root:
#
#   docker build -f apps/web/Dockerfile -t omnarr-web .

FROM oven/bun:1.4.4 AS build
WORKDIR /src
# Every workspace's manifest, so the lockfile resolves; then the sources.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
COPY packages/parser/package.json packages/parser/
COPY packages/scoring/package.json packages/scoring/
COPY scripts/package.json scripts/
COPY e2e/package.json e2e/
COPY e2e/apps/upgrade-v1/package.json e2e/apps/upgrade-v1/
COPY e2e/apps/upgrade-v2/package.json e2e/apps/upgrade-v2/
RUN bun install --frozen-lockfile --ignore-scripts --filter @omnarr/web
COPY tsconfig.json vite.config.ts ./
COPY packages packages
COPY apps/web apps/web
RUN cd apps/web && bunx nuxt build
# /licenses: the bundled npm packages' notices, and the platform's own licence.
COPY LICENSE ./
COPY scripts/notices.ts scripts/
RUN mkdir licenses && cp LICENSE licenses/LICENSE \
  && bun scripts/notices.ts --workspace @omnarr/web --root /src --out licenses/THIRD_PARTY_NOTICES.md

FROM node:24-trixie-slim
ARG OMNARR_VERSION=0.0.0-dev
WORKDIR /app
COPY --from=build /src/apps/web/.output ./.output
COPY --from=build /src/licenses /licenses
USER node
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  NUXT_PUBLIC_OMNARR_VERSION=$OMNARR_VERSION
EXPOSE 3000
LABEL org.opencontainers.image.version=$OMNARR_VERSION \
  org.opencontainers.image.source=https://github.com/dev-marzahn/omnarr \
  org.opencontainers.image.licenses=GPL-3.0-only
CMD ["node", ".output/server/index.mjs"]
