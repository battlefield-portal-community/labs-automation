# One image, all automations. Node runs the TypeScript sources directly
# (type stripping), so there is no build stage and nothing to keep in sync.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HEALTH_PORT=8080

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi \
 && npm cache clean --force

COPY src ./src
COPY sql ./sql

USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${HEALTH_PORT}/healthz" >/dev/null 2>&1 || exit 1

# `start` by default; override with `docker compose run --rm automations migrate`
# or `... device-auth /path/to/token`.
CMD ["node", "src/index.ts"]
