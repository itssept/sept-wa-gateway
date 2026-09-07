# SEPT WhatsApp Gateway — Bun runtime image.
#
# Multi-stage build. The final runtime image contains ONLY a bundled,
# minified application (dist/), production node_modules, and package.json.
# It deliberately never copies src/ or tsconfig.json, so the readable
# TypeScript source is not shipped to anyone who pulls the image. (Bundling
# and minification reduce casual source exposure; they do not make the
# implementation unrecoverable.)
#
# Baileys pulls native deps (protobuf); we keep node_modules external to the
# bundle so those resolve at runtime instead of being inlined. The DB and
# encrypted session state live on a MOUNTED VOLUME at /data — never baked in.

# --- deps: resolve production dependencies against the lockfile. ---
FROM oven/bun:1.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- build: bundle + minify the app into dist/server.js. ---
# Dependencies stay EXTERNAL (--packages external): baileys and its native
# protobuf bits are loaded from node_modules at runtime, not inlined. This
# stage needs the full (dev) dependency tree for the bundler + type stubs.
FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun build src/http/server.ts \
      --target=bun \
      --packages=external \
      --minify \
      --outfile dist/server.js

# --- runtime: minimal image, no source. ---
FROM oven/bun:1.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Link the GHCR package to this repo (inherits repo visibility/permissions,
# shows on the repo's Packages panel).
LABEL org.opencontainers.image.source="https://github.com/hasura/sept-wa-gateway"

# Bundled app + resolved production node_modules only. No src/, no tsconfig.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Durable state lives here — mount a volume at /data in your platform.
ENV GATEWAY_DB_PATH=/data/sept-wa-gateway.sqlite
# Bind all interfaces; the platform ingress gates access.
ENV GATEWAY_API_HOST=0.0.0.0
ENV GATEWAY_API_PORT=8790

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8790

# Run the bundled entrypoint (Bun executes the minified JS).
CMD ["bun", "run", "dist/server.js"]
