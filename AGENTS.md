# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains all TypeScript source code. Entry point is `src/index.ts`.
- Core areas: `src/bot/` (Telegram commands and conversations), `src/scheduler/` (cron-driven windows, reminders, finalization), `src/db/` (Drizzle schema + SQLite client), `src/services/` (integrations like file storage/OpenRouter), `src/monitoring/` (Sentry), `src/types/` and `src/constants.ts`.
- Tests live alongside code as `*.test.ts` (e.g., `src/bot/*.test.ts`, `src/db/*.test.ts`).
- `data/` stores runtime SQLite DB and photos (`data/photos/...`).
- `dist/` is the compiled output from `tsc`.
- `spec.md` documents bot behavior and flows.

## Build, Test, and Development Commands
- `npm ci` installs dependencies (recommended for clean installs).
- `npm run dev` starts the bot in watch mode via `tsx` against `src/index.ts`.
- `npm run build` compiles TypeScript to `dist/`.
- `npm start` runs the compiled bot from `dist/index.js`.
- `npm test` runs the Vitest suite once.
- `npm run test:watch` runs Vitest in watch mode.
- `npm run typecheck` runs `tsc --noEmit` for strict type checks.

## Coding Style & Naming Conventions
- TypeScript, ESM (`"type": "module"`), Node >= 20.
- Use `.js` extensions in TS import paths (e.g., `import { foo } from "./foo.js"`).
- Indentation is 2 spaces; semicolons are used.
- File naming follows `camelCase.ts`, tests use `*.test.ts`.
- No ESLint/Prettier config is present; keep formatting consistent with existing files and rely on `tsc` + reviews.

## Testing Guidelines
- Framework: Vitest (`vitest.config.ts`, Node environment).
- Keep tests co-located with modules and name them `*.test.ts`.
- Prefer deterministic tests; avoid network calls in unit tests.

## Commit & Pull Request Guidelines
- Commit messages follow Conventional Commits; recent history uses `feat:`, `fix:`, `chore:`, `docs:` (e.g., `feat: add scheduler tasks`).
- PRs should include a clear summary, test results (`npm test`/`npm run typecheck`), and any config changes (`.env.example`, `README.md`, `spec.md`) when behavior or setup changes.

## Configuration & Runtime Notes
- Local config lives in `.env` (see `.env.example`). Key vars include `BOT_TOKEN`, `DATABASE_URL`, `OPENROUTER_API_KEY`, `SENTRY_DSN`.
- The bot uses long polling; in production, run a single instance to avoid duplicate processing.
