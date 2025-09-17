# Repository Guidelines

## Project Structure & Module Organization
The TypeScript source lives in `src/`. `src/index.ts` boots the Hono HTTP server, while database models are grouped under `src/db/` with Drizzle schemas in `schema.ts`. Generated SQL migrations are written to `drizzle/`, configured through `drizzle.config.ts`. Local PostgreSQL-lite state persists in `pg_data/`. Compiled JavaScript targets `dist/` after a build.

## Build, Test, and Development Commands
Install dependencies with `pnpm install` (stays in sync with `pnpm-lock.yaml`). Run `pnpm dev` for a reloadable development server via `tsx`. Use `pnpm build` to emit `dist/` through `tsc`, and `pnpm start` to serve the compiled output. Apply schema changes with `pnpm db:update`, which generates and pushes Drizzle migrations using the `DATABASE_URL` connection string.

## Coding Style & Naming Conventions
Follow TypeScript strict-mode expectations and keep modules ESM-friendly (`.ts` imports without default extensions). Use two-space indentation, trailing semicolons, and double quotes to match existing files. Name tables and columns in snake_case (`visit_log`, `created_at`) and export Drizzle objects in camelCase (`visitLog`). Run `pnpm build` before submitting to ensure the code type-checks cleanly.

## Testing Guidelines
A formal test harness is not yet established. When contributing logic, include targeted tests (e.g., `node:test` or `vitest`) and wire them into a `pnpm test` script. Prefer lightweight integration tests that exercise the Hono routes and Drizzle queries. Document any schema fixtures added beneath `src/db/` so they can be reused.

## Commit & Pull Request Guidelines
Project history is unavailable in this workspace, so default to conventional, imperative commit subjects (e.g., `feat: add visit log endpoint`), keeping them under 72 characters. Reference related issues in the body when relevant. Pull requests should describe the change, list testing evidence (`pnpm build`, manual route checks), and include screenshots or sample responses for API updates. Coordinate database migrations by noting the generated files under `drizzle/` in the PR description.

## Environment & Configuration Tips
Copy `.env.example` (if present) or create `.env` with `DATABASE_URL=postgres://...` before running commands. `db:update` and the runtime server both rely on this variable; when using PGlite locally, a path URL such as `file:./pg_data/local.db` keeps data inside the repo. Avoid committing `.env` or the `pg_data/` contents.
