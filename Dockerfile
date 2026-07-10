FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/notifiers/package.json packages/notifiers/package.json
COPY packages/store/package.json packages/store/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @kaname-relay/web build \
  && pnpm --filter @kaname-relay/server build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
ENV PORT="3000"
ENV DATABASE_URL="file:/data/kaname-relay.sqlite"
ENV KANAME_WEB_DIR="/app/apps/web/dist"
ENV KANAME_MIGRATIONS_DIR="/app/packages/store/migrations"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/notifiers/package.json packages/notifiers/package.json
COPY packages/store/package.json packages/store/package.json

RUN pnpm install --prod --frozen-lockfile --filter @kaname-relay/server...

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/store/migrations packages/store/migrations

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
