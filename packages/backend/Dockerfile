# The backend image: convex-release's combined image with the
# platform's bundle, the pre-push and post-apply hooks and
# reset-admin-password. convex-release's entrypoint and health check are
# unchanged. Build from the repository root:
#
#   docker build -f packages/backend/Dockerfile -t omnarr-backend .
#
# The release workflow passes OMNARR_VERSION and, as the `tmdb_token` build
# secret, the built-in TMDB token. The base image, by tag and digest, equals
# the catalog's @dev-marzahn/convex-release version; `convex-release bundle`
# refuses another. Bump all three together.

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
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY packages packages
# The hook script and the reset command: standalone Node files.
RUN cd packages/backend && bunx vp pack
# /licenses: the bundled npm packages' notices, and the platform's own licence.
# The Convex backend (FSL-1.1-Apache-2.0) and convex-release (MPL-2.0) come with the base image.
COPY LICENSE ./
COPY scripts/notices.ts scripts/
RUN mkdir licenses && cp LICENSE licenses/LICENSE \
  && bun scripts/notices.ts --workspace @omnarr/backend --root /src --out licenses/THIRD_PARTY_NOTICES.md

FROM ghcr.io/dev-marzahn/convex-release:100.2.1-runtime@sha256:ba159d27c0df70d6d51441398f90cb4021d0f97d69711670c41b6717f97908ff AS bundle
ARG OMNARR_VERSION=0.0.0-dev
COPY --from=build /src /src
WORKDIR /src/packages/backend
# convex-release records package.json's version as CONVEX_RELEASE_VERSION, which System shows.
RUN node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.version=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(p,null,2))" "$OMNARR_VERSION" \
  && node_modules/.bin/convex-release bundle /convex/app

FROM ghcr.io/dev-marzahn/convex-release:100.2.1-runtime@sha256:ba159d27c0df70d6d51441398f90cb4021d0f97d69711670c41b6717f97908ff
ARG OMNARR_VERSION=0.0.0-dev
COPY --from=bundle /convex/app/ /convex/app/
COPY --from=build /src/packages/backend/dist/image/ /omnarr/
COPY --from=build /src/licenses /licenses
RUN printf '#!/bin/sh\nexec node /omnarr/reset.mjs "$@"\n' > /usr/local/bin/reset-admin-password \
  && chmod 0755 /usr/local/bin/reset-admin-password
# The built-in TMDB token, only when the build has the secret.
RUN --mount=type=secret,id=tmdb_token,required=false \
  if [ -s /run/secrets/tmdb_token ]; then cp /run/secrets/tmdb_token /omnarr/tmdb_token && chmod 0400 /omnarr/tmdb_token; fi
ENV OMNARR_VERSION=$OMNARR_VERSION \
  CONVEX_RELEASE_PRE_PUSH="node /omnarr/hooks.mjs pre-push" \
  CONVEX_RELEASE_POST_APPLY="node /omnarr/hooks.mjs post-apply"
LABEL org.opencontainers.image.version=$OMNARR_VERSION \
  org.opencontainers.image.source=https://github.com/dev-marzahn/omnarr \
  org.opencontainers.image.licenses="GPL-3.0-only AND FSL-1.1-Apache-2.0 AND MPL-2.0"
