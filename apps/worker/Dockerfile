# The worker image. Build from the repository root:
#
#   docker build -f apps/worker/Dockerfile -t omnarr-worker .
#
# CI's worker-image job also builds the `test` stage and runs
# apps/worker's tests in it, against the image's own ffmpeg and unar:
#
#   docker build -f apps/worker/Dockerfile --target test -t omnarr-worker-test .
#   docker run --rm omnarr-worker-test

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
RUN bun install --frozen-lockfile --ignore-scripts --filter @omnarr/worker
COPY tsconfig.json vite.config.ts ./
COPY packages packages
COPY apps/worker apps/worker
RUN cd apps/worker && bunx vp pack
# /licenses: the bundled npm packages' notices, and the platform's own licence.
COPY LICENSE ./
COPY scripts/notices.ts scripts/
RUN mkdir licenses && cp LICENSE licenses/LICENSE \
  && bun scripts/notices.ts --workspace @omnarr/worker --root /src --out licenses/THIRD_PARTY_NOTICES.md

# Node runs the bundle; the worker runs Debian's ffmpeg 7.1 and The
# Unarchiver's unar and lsar as child processes. Debian's ffmpeg is
# built without nonfree parts, so it can be redistributed.
FROM node:24-trixie-slim AS tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg unar \
  && rm -rf /var/lib/apt/lists/*

# apps/worker's tests on the image's tools, as the worker's user.
# The real-tool tests are required here, not skipped.
FROM tools AS test
COPY --from=build --chown=node:node /src /src
USER node
WORKDIR /src/apps/worker
ENV OMNARR_REQUIRE_MEDIA_TOOLS=1
CMD ["/src/apps/worker/node_modules/.bin/vp", "test", "run"]

FROM tools
ARG OMNARR_VERSION=0.0.0-dev
WORKDIR /app
COPY --from=build /src/apps/worker/dist/main.mjs ./main.mjs
COPY --from=build /src/licenses /licenses
# Debian's packages with their exact versions and the written source offer, and
# ffmpeg's configure line. Debian's copyright files stay in /usr/share/doc.
RUN { printf '%s\n' \
    '# The Debian packages in this image, with their exact versions (dpkg-query -W).' \
    '# Source offer: the source of each package at exactly this version is available from' \
    '# https://snapshot.debian.org/ (search by package name and version). The omnarr project' \
    '# keeps this offer valid (GPLv3 section 6(d), GPLv2 section 3(c)); the release notes' \
    '# record these versions too.' \
    ''; dpkg-query -W -f='${Package} ${Version}\n'; } > /licenses/packages.txt \
  && ffmpeg -hide_banner -version | grep '^configuration:' > /licenses/ffmpeg-configure.txt
# The compose file sets the user: PUID:PGID for the worker, 0:0 for `setup`.
USER node
# The release, for the support bundle.
ENV DATA_DIR=/data \
  OMNARR_VERSION=$OMNARR_VERSION
LABEL org.opencontainers.image.version=$OMNARR_VERSION \
  org.opencontainers.image.source=https://github.com/dev-marzahn/omnarr \
  org.opencontainers.image.licenses=GPL-3.0-only
# SIGTERM releases held jobs before the process exits.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/main.mjs"]
