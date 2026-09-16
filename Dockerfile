# Sahayak — production image.
#
#   docker build -t sahayak:latest .
#
# Debian slim rather than Alpine: Prisma's query engine is built against glibc
# and OpenSSL, and the musl variant is one more thing to get wrong on a server
# nobody is watching. The runtime stage carries only the standalone output.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
# Placeholders so modules that assert their connection string at import can be
# loaded while the build collects page data. Nothing connects during a build,
# these are not credentials, and they do not reach the runtime stage — the real
# URLs come from the server's env file when the container starts.
ARG BUILD_DB_PLACEHOLDER=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=$BUILD_DB_PLACEHOLDER DIRECT_URL=$BUILD_DB_PLACEHOLDER PLATFORM_DATABASE_URL=$BUILD_DB_PLACEHOLDER
RUN npx prisma generate
RUN npm run build
# The standalone server does not copy these itself.
RUN cp -r .next/static .next/standalone/.next/ \
 && if [ -d public ]; then cp -r public .next/standalone/; fi

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 TZ=Asia/Kolkata
COPY --from=build --chown=node:node /app/.next/standalone ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/signin/ >/dev/null || exit 1
CMD ["node", "server.js"]
