# SEPT WhatsApp Gateway — Bun runtime image.
#
# Baileys needs a couple of native deps (ffi via node-gyp is avoided by baileys
# 7, but we keep the toolchain slim). The DB and encrypted session state live on
# a MOUNTED VOLUME at /data — never bake them into the image.

FROM oven/bun:1.2 AS deps
WORKDIR /app
# Install dependencies against the lockfile for reproducibility.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Link the GHCR package to this repo (inherits repo visibility/permissions,
# shows on the repo's Packages panel).
LABEL org.opencontainers.image.source="https://github.com/hasura/sept-wa-gateway"

# App + resolved node_modules.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Durable state lives here — mount a volume at /data in your platform.
ENV GATEWAY_DB_PATH=/data/sept-wa-gateway.sqlite
# Bind all interfaces; the platform ingress gates access.
ENV GATEWAY_API_HOST=0.0.0.0
ENV GATEWAY_API_PORT=8790

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8790

# Run directly from TypeScript source (Bun executes .ts).
CMD ["bun", "run", "src/http/server.ts"]
