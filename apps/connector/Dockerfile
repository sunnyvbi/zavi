
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
ARG CONNECTOR_VERSION=""
ENV CONNECTOR_VERSION=${CONNECTOR_VERSION}
WORKDIR /repo
COPY . .
RUN npm ci --workspace @zavi/connector --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
 && npm run build --workspace @zavi/connector

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps
WORKDIR /repo
COPY . .
RUN npm ci --workspace @zavi/connector --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir -p apps/connector/node_modules

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
ENV NODE_ENV=production \
    ZAVI_DATA_DIR=/data \
    ZAVI_LOCAL_BIND=0.0.0.0 \
    ZAVI_LOCAL_PORT=7801
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn* \
 && mkdir -p /data && chown node:node /data && chmod 700 /data
WORKDIR /app/apps/connector
COPY --from=deps /repo/node_modules /app/node_modules
COPY --from=deps /repo/apps/connector/node_modules /app/apps/connector/node_modules
COPY --from=build /repo/apps/connector/dist /app/apps/connector/dist
COPY --from=build /repo/apps/connector/package.json /app/apps/connector/package.json
USER node
VOLUME ["/data"]
EXPOSE 7801
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "dist/main.js", "healthcheck"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
