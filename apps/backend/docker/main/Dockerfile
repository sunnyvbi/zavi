
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm install --workspace=apps/backend --workspace=packages/shared --include-workspace-root --legacy-peer-deps --os=linux --cpu=x64 --libc=glibc && \
    npm cache clean --force && \
    mkdir -p apps/backend/node_modules apps/web/node_modules packages/shared/node_modules

RUN node -e "const s=require('sharp'); console.log('sharp ok:', JSON.stringify(s.versions))"

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY apps/backend ./apps/backend
COPY packages/shared ./packages/shared
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./

ENV NODE_OPTIONS="--max-old-space-size=6144"
RUN npm run build:backend

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

COPY package.json package-lock.json* ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --workspace=apps/backend --workspace=packages/shared --include-workspace-root --legacy-peer-deps --omit=dev --os=linux --cpu=x64 --libc=glibc && \
    npm cache clean --force

COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/backend/src/agents ./apps/backend/src/agents
COPY --from=build /app/apps/backend/src/channels ./apps/backend/src/channels
COPY --from=build /app/apps/backend/src/services/slack/knowledge ./apps/backend/src/services/slack/knowledge
COPY --from=build /app/apps/backend/src/services/agents/codegen-templates ./apps/backend/src/services/agents/codegen-templates
COPY --from=build /app/apps/backend/src/services/reports/social-image/fonts ./apps/backend/src/services/reports/social-image/fonts
COPY --from=build /app/apps/backend/skills ./apps/backend/skills
COPY apps/backend/scripts/docker-entrypoint.sh /app/apps/backend/scripts/docker-entrypoint.sh
COPY apps/backend/scripts/docker-load-secrets.cjs /app/apps/backend/scripts/docker-load-secrets.cjs
COPY apps/backend/eval/live-replay ./apps/backend/eval/live-replay

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git \
      fontconfig \
      fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-lohit-deva \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f
RUN chmod +x /app/apps/backend/scripts/docker-entrypoint.sh

COPY packages/launch-video/references ./packages/launch-video/references
COPY packages/launch-video/examples ./packages/launch-video/examples

COPY infra/site-shard/migrations ./infra/site-shard/migrations
COPY infra/site-shard/auth ./infra/site-shard/auth

COPY packages/launch-video /tmp/lv-engine-src
RUN tar czf /app/apps/backend/launch-video-engine.tgz \
      -C /tmp/lv-engine-src --exclude=node_modules --exclude=out . \
    && rm -rf /tmp/lv-engine-src \
    && echo "launch-video-engine.tgz $(stat -c%s /app/apps/backend/launch-video-engine.tgz) bytes"

ENV NODE_OPTIONS="--max-old-space-size=2048"

EXPOSE 4000
WORKDIR /app/apps/backend

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=5 \
  CMD curl -f http://localhost:4000/livez || exit 1

ENTRYPOINT ["/app/apps/backend/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
