# tav

Small Hono + Drizzle (PGlite) playground. It serves a minimal HTTP endpoint and ships game-like domain logic for characters (tavs), skills, tasks, and an inventory system validated by tests.

## Quick Start

1. Setup environment

```
cp .env.example .env
# .env should contain: DATABASE_URL=file:./pg_data/local.db
```

2. Install and run the dev server

```
pnpm install
pnpm db:update   # generate + apply Drizzle migrations
pnpm dev
```

Open <http://localhost:3000>

The root route inserts a row into `visit_log` and responds like:

```
Hello Hono: 1 2025-01-01T00:00:00.000Z
```

## Scripts

```
pnpm dev      # reloadable server via tsx (src/index.ts)
pnpm build    # compile to dist/ with tsc
pnpm start    # run compiled server (dist/index.js)
pnpm test     # run vitest (unit/integration tests under src/lib)
pnpm db:update# drizzle-kit generate + push using DATABASE_URL
```

## Stack

- Hono (`@hono/node-server`) for the HTTP layer
- Drizzle ORM with PGlite driver for local Postgres-lite storage
- Zod + smol-toml for config validation and parsing
- TypeScript strict mode; ESM modules
- Vitest (+ V8 coverage) for tests

## Project Structure

- `src/index.ts` – boots the Hono server and logs visits
- `src/db/schema.ts` – Drizzle schema + requirement evaluation helpers
- `src/config.ts` – loads and validates `data/config.toml` (skills/targets/items, XP thresholds)
- `src/lib/` – domain logic
  - `tav.ts` – create/load/delete tavs; add tasks with requirement checks
  - `task.ts` – tick scheduler: starts/completes tasks, applies rewards (XP, inventory)
  - `inventory.ts` – stack-aware inventory ops (apply deltas, move/merge/swap, set totals)
  - `items.ts` – item definition lookup and stack limits
- `data/config.toml` – declarative skill/target/item definitions
- `drizzle/` – generated SQL migrations (managed by Drizzle Kit)

## HTTP API

Base URL: `http://localhost:3000`

Tavs
- List: `GET /tav`
  - `curl -s http://localhost:3000/tav`
- Create: `POST /tav` { name }
  - `curl -sX POST http://localhost:3000/tav -H 'content-type: application/json' -d '{"name":"Alice"}'`
- Read: `GET /tav/:id`
  - `curl -s http://localhost:3000/tav/1`
- Update: `PUT /tav/:id` { name?, scheduleId? }
  - `curl -sX PUT http://localhost:3000/tav/1 -H 'content-type: application/json' -d '{"name":"Alice L.","scheduleId":null}'`
- Delete: `DELETE /tav/:id`
  - `curl -sX DELETE http://localhost:3000/tav/1`

Inventory (per tav)
- List stacks: `GET /tav/:tavId/inventory`
  - `curl -s http://localhost:3000/tav/1/inventory`
- Add items: `POST /tav/:tavId/inventory/add` { itemId, qty?=1 }
  - `curl -sX POST http://localhost:3000/tav/1/inventory/add -H 'content-type: application/json' -d '{"itemId":"log","qty":2}'`
- Remove items: `POST /tav/:tavId/inventory/remove` { itemId, qty?=1, strict?=true }
  - `curl -sX POST http://localhost:3000/tav/1/inventory/remove -H 'content-type: application/json' -d '{"itemId":"log","qty":1}'`
- Move/merge/swap stacks: `POST /tav/:tavId/inventory/move` { fromSlot, toSlot }
  - `curl -sX POST http://localhost:3000/tav/1/inventory/move -H 'content-type: application/json' -d '{"fromSlot":0,"toSlot":3}'`

Tasks (per tav)
- List: `GET /tav/:tavId/tasks`
  - `curl -s http://localhost:3000/tav/1/tasks`
- Add: `POST /tav/:tavId/tasks` { skillId, targetId?, priority? }
  - `curl -sX POST http://localhost:3000/tav/1/tasks -H 'content-type: application/json' -d '{"skillId":"meditate","targetId":null,"priority":6}'`
- Tick scheduler: `GET /tav/:tavId/tasks/tick` (no body)
  - `curl -s http://localhost:3000/tav/1/tasks/tick`

## Database & Migrations

- Configure `DATABASE_URL` (see `.env.example`). For local PGlite use a file path URI like `file:./pg_data/local.db` to persist data in-repo.
- Generate and push schema changes with `pnpm db:update` (uses `drizzle.config.ts`).
- Tables include `tav`, `skill`, `task`, `inventory`, and `visit_log`.

## Testing

Run the test suite:

```
pnpm test
```

Tests focus on `src/lib/` and cover:

- Requirement evaluation and context merging
- Task ticking and completion effects (XP, inventory)
- Inventory stacking, deltas, slot moves/merges/swaps
- Item definition lookups and stack limits

Coverage output is written under `coverage/`.

## Notes

- Ensure `DATABASE_URL` is set before running the server or migrations.
- When adjusting schemas, commit the generated SQL under `drizzle/`.
- Skills can target a special "no target" key via `TASK_TARGETLESS_KEY` (the literal string `"null"`).

## TODO

- Docs: document the requirement DSL and `data/config.toml` schema with examples.
- Tests: lightweight Hono integration tests for routes; expand coverage thresholds.
- CLI: add a small CLI to run ticks and inspect tav state from the terminal.
- DX: add lint/format scripts (eslint/prettier) and a `pnpm test:watch` convenience.
- Data: seed script for sample tavs/inventory; include fixture loader.
- DB: consider optional Postgres runtime driver behind env for non-PGlite deployments.
- Observability: structured logging, request IDs, and basic error middleware.
- Deployment: Dockerfile and CI workflow to run build/tests and publish coverage.
