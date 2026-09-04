# SEPT WhatsApp Gateway — dev task runner.
# Run `just` to list recipes. Config comes from .env (loaded automatically).

set dotenv-load := true

_default:
    @just --list

# Install dependencies.
install:
    bun install

# Run the gateway with hot reload.
dev:
    bun run --watch src/http/server.ts

# Run the gateway.
start:
    bun run src/http/server.ts

# Typecheck the project.
typecheck:
    tsc --noEmit

# Run the test suite.
test:
    bun test

# Typecheck + test (use before committing).
check: typecheck test

# List the live PromptQL MCP tools (uses PROMPTQL_MCP_TEST_PAT from .env).
discover:
    bun run src/promptql/discover.ts

# Build + start the gateway in Docker (SQLite persists in ./data).
up:
    docker compose up --build -d

# Stop the gateway.
down:
    docker compose down

# Follow the gateway logs.
logs:
    docker compose logs -f
