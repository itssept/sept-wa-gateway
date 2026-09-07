# Deployment

The gateway ships as a container image on **GitHub Container Registry (GHCR)**.
This repo does not prescribe an orchestration approach — plain `docker run`,
Compose, Kubernetes, Nomad, or a PaaS all work. The deployer's job is to give the
image the right environment, a durable volume, and network access. This doc
covers:

1. [How images are built and released](#image-release-ghcr)
2. [What the image requires to run](#image-requirements)
3. [Environment variables](#environment-variables)
4. [Deployment checklist](#deployment-checklist)

## Image release (GHCR)

Images are published by the **Publish image** GitHub Actions workflow
(`.github/workflows/release.yml`).

**Registry / name**

```
ghcr.io/hasura/sept-wa-gateway
```

On a manual run you can override the name.

**Triggers**

| Trigger | How | Result |
|---|---|---|
| Version release | Push a git tag `v<semver>` (e.g. `v1.2.3`, `v1.2.3-rc1`) | Tagged release image + `latest` |
| Manual / ad-hoc | Actions tab → **Publish image** → Run workflow (any branch) | Branch-named + short-SHA image (no `latest`) |

**Tags produced**

- On a version tag push: `1.2.3`, `1.2` (major.minor), and `latest`.
  Pre-releases (`v1.2.3-rc1`) publish the version tag but **not** `latest`.
- On manual dispatch: the branch name and a `sha-<short>` tag. Use these for
  test or preview deploys; they never move `latest`.

**Architecture** — multi-arch **amd64 + arm64**. Each arch builds natively on its
own runner (no QEMU), then a merge step combines them into one manifest under the
tags above. Pulling the tag on either arch resolves to the right image.

**To cut a release**

```bash
git tag v1.2.3
git push origin v1.2.3
```

Watch the run in the Actions tab. When it finishes,
`ghcr.io/hasura/sept-wa-gateway:1.2.3` and `:latest` are available to pull.

> **Permissions:** the workflow pushes with the built-in `GITHUB_TOKEN`
> (`packages: write`). No extra secret is needed to publish. Making the GHCR
> package public, or granting pull access to a private one, is a one-time
> repository/package setting.

## Image requirements

The image is self-contained. These are baked in (`Dockerfile`) — you do not set
them, but you must satisfy them:

| Requirement | Value | Why it matters |
|---|---|---|
| **Exposed port** | `8790` (`GATEWAY_API_PORT`) | The management + routing HTTP API. Map/route it. |
| **Bind address** | `0.0.0.0` (`GATEWAY_API_HOST`) | Reachable inside the container network. Put it behind your ingress. |
| **Data volume** | `/data` (declared `VOLUME`) | SQLite DB path is baked to `/data` (`GATEWAY_DB_PATH`). Mount durable, backed-up storage here. |

**The `/data` volume is not optional.** It holds the only copy of:

- the encrypted Baileys **session state** (the linked WhatsApp number), and
- **per-shopper MCP tokens**, encrypted at rest.

Lose the volume and you must re-link the number and re-register every shopper.
Both are encrypted with `DATA_ENCRYPTION_KEY`, so that key must persist alongside
the volume.

**One owner per number.** A linked WhatsApp session must have exactly one running
owner. Do **not** run two replicas against the same number/volume — it will fight
over the session and risks a ban. Scale by adding connections/numbers, not
replicas.

## Environment variables

Secrets must be provisioned **out of band** (a secret manager / platform
secrets), never baked into the image. See `.env.example` for the annotated list.

### Mandatory

| Variable | Notes |
|---|---|
| `GATEWAY_ADMIN_TOKEN` | Admin credential for `/api/v1/*`, constant-time compared. Generate: `openssl rand -hex 32`. |
| `DATA_ENCRYPTION_KEY` | 32-byte key (64 hex) for AES-256-GCM at rest. **Must stay stable** across restarts/redeploys or persisted session + secrets become unreadable. Generate: `openssl rand -hex 32`. |
| `PROMPTQL_PROJECT_URL` | PromptQL base URL (scheme + host), no trailing slash. e.g. `https://data.prompt.ql.app`. |
| `PROMPTQL_MCP_PATH` | MCP path + query appended to the base. Must include the `project-name` query param. e.g. `/promptql/mcp-server/mcp?project-name=<project>`. |

### Optional (sensible defaults)

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_API_PORT` | `8790` | HTTP API port. |
| `GATEWAY_API_HOST` | `0.0.0.0` | Bind interface. |
| `GATEWAY_DB_PATH` | `/data/sept-wa-gateway.sqlite` | SQLite file. Keep it under the `/data` volume. |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error`. Structured JSON logs to stderr. |
| `WHATSAPP_CONNECTION_ID` | `sept-gateway-1` | Opaque routing key (one connection per process). |
| `WHATSAPP_DEVICE_LABEL` | Ubuntu Chrome | Label shown under Linked Devices. |
| `WHATSAPP_SEND_RATE_PER_SEC` | `1` | Anti-ban send pacing. |
| `WHATSAPP_WARMUP_DAYS` | `3` | Anti-ban warm-up ramp. |
| `WHATSAPP_MAX_PENDING_SENDS_PER_CONNECTION` | `100` | Backpressure bound. |
| `WHATSAPP_GROUP_META_TTL_MS` | `3600000` | Group metadata cache TTL. |
| `WHATSAPP_MESSAGE_RETENTION_DAYS` | `90` | Retention window (purge job not yet wired). |
| `PROMPTQL_MCP_AUTH_SCHEME` | `pat` | Auth scheme prefixed to the per-shopper token. |
| `PROMPTQL_MCP_PROTOCOL_VERSION` | `2025-03-26` | MCP `initialize` protocol version. |
| `PROMPTQL_MCP_TIMEOUT_MS` | `30000` | Per-request MCP timeout. |
| `PROMPTQL_MCP_MAX_RETRIES` | `3` | Bounded transient-retry count. |
| `PROMPTQL_RESPONSE_MAX_MS` | `180000` | Overall ceiling for the ask → blocking-response flow. |

### Never set in env

- **The WhatsApp number.** It is linked at runtime via
  `POST /api/v1/connection/link` and persisted (encrypted) in `/data`. On reboot
  the gateway resumes the linked session automatically.
- **Per-shopper MCP tokens.** They are supplied through the admin API
  (`POST /api/v1/shoppers`) and stored encrypted in the DB.
- `PROMPTQL_MCP_TEST_PAT` is a **local diagnostic only** (`bun run mcp:discover`).
  It is not used by the running gateway; do not ship it in a deployment.

## Deployment checklist

1. **Pull the image**: `ghcr.io/hasura/sept-wa-gateway:<tag>` (pin a version tag,
   not `latest`, for reproducible deploys).
2. **Provision secrets** out of band: `GATEWAY_ADMIN_TOKEN`,
   `DATA_ENCRYPTION_KEY` (both `openssl rand -hex 32`).
3. **Set PromptQL config**: `PROMPTQL_PROJECT_URL` + `PROMPTQL_MCP_PATH`.
4. **Mount a durable, backed-up volume at `/data`.** Confirm `DATA_ENCRYPTION_KEY`
   is stored so it survives redeploys.
5. **Expose port `8790`** behind your ingress. The admin token gates every
   `/api/v1/*` call — the ingress URL is not a security boundary.
6. **Run exactly one instance** per WhatsApp number/volume.
7. **Link the number**: `POST /api/v1/connection/link`, then poll
   `GET /api/v1/connection` for the pairing code (see [README](../README.md)).
8. **Register shoppers**: `POST /api/v1/shoppers` with their `roomName` and
   MCP token.

See **[admin-api.md](admin-api.md)** for the full API reference.
