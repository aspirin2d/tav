# Repository Guidelines

## Scope & Precedence
This AGENTS.md applies to the entire repository. If additional AGENTS.md files appear in subdirectories, the most deeply nested one takes precedence for files under its directory. Direct instructions from the user or task prompt supersede this file.

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

## Agent Workflow (Codex CLI)
- Prefer `rg`/`ripgrep` for searching and read files in chunks (<=250 lines).
- Use `apply_patch` for all edits; keep changes minimal and focused on the task.
- For multi-step work, maintain a short plan with exactly one `in_progress` step.
- Send a brief preamble before grouped shell commands; avoid noise for trivial reads.
- Validate with `pnpm build` for type checks; run `pnpm test` if tests are affected.
- Do not introduce unrelated fixes, rename files unnecessarily, or add license headers.
- Follow ESM imports (no file extensions), strict TypeScript, two-space indent, semicolons, and double quotes.

## Common Agent Tasks
- Schema change: update `src/db/schema.ts`, run `pnpm db:update`, and reference new tables in code. Include notes about generated files under `drizzle/`.
- Add route: update `src/index.ts` (Hono), create handler modules in `src/` as needed, and document sample requests in the PR/commit body.
- Data/config changes: adjust `data/config.toml`, update types/validators in `src/config.ts`, and extend tests under `src/lib/`.

## Troubleshooting
- `DATABASE_URL` missing: create `.env` with a PGlite file path `file:./pg_data/local.db`.
- Migrations out of sync: re-run `pnpm db:update` and ensure `drizzle/` is updated.
- ESM import errors: ensure imports omit file extensions and use relative paths from `.ts` files.
