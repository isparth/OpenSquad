# OpenSquad contributor guide

Open-source agent platform with BYOK. Users create bots that each get a model, a sandbox, memory, an email inbox, a phone number and tools. Design doc: `llm_docs/SPEC.md` (gitignored, local only; ask the maintainer for it if missing). Read it before touching architecture.

Everything is TypeScript. Node 22, pnpm 11, Docker for Postgres.

## Layout

```text
apps/api        Fastify backend
apps/desktop    Electron + React desktop app (electron-vite, Tailwind, electron-builder)
packages/core   Core primitives (Agent, Conversation, ...) and capability interfaces. No provider code.
packages/db     Drizzle schema, migrations, Postgres client
plugins/*       One package per provider. The only places a provider SDK may be imported.
```

Inside `apps/api/src`:

```text
app.ts                 builds the Fastify instance (used by tests)
server.ts              starts it
config/env.ts          zod-validated env, fails fast
auth/                  Clerk lives here and nowhere else. Routes read request.userId.
capabilities/registry  maps each capability to its plugin. Swap a provider = change one line.
plugins/               Fastify decorators: env, db, capabilities
modules/<feature>/     routes.ts (HTTP, zod schemas) + service.ts (data access, no HTTP)
```

Inside `apps/desktop/src`:

```text
main/        Electron main process. window.ts (BrowserWindow, CSP, navigation rules), ipc.ts, config.ts
preload/     contextBridge. The only surface the renderer gets, typed as window.opensquad
shared/      IPC channel names and payload types, imported by all three sides
renderer/    React app
  src/features/<feature>/   page component + hooks for one feature
  src/components/           shared presentational components
  src/lib/api/              fetch client for the Fastify API
```

## Commands

```text
pnpm install
cp .env.example .env          # defaults work for local dev
docker compose up -d --wait   # Postgres on :5432
pnpm db:migrate
pnpm dev                      # api on http://localhost:3000, foreground, use its own terminal
pnpm dev:desktop              # Electron app with HMR, foreground, needs the api running
pnpm test
pnpm lint                     # biome, also enforces the import boundary below
pnpm typecheck
pnpm build                    # api to dist/, desktop to out/
pnpm db:generate              # after editing packages/db/src/schema
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @opensquad/desktop package   # unsigned app in apps/desktop/release/
```

Tests hit the real Postgres from docker compose. There is no mock database. Desktop tests run under jsdom with `window.opensquad` stubbed in `apps/desktop/test/setup.ts`.

Things that look wrong but aren't:

- `pnpm db:migrate` prints Postgres NOTICE objects (`schema "drizzle" already exists`) on re-runs. Harmless. "migrations applied" at the end is the signal.
- The first `package` run downloads an Electron zip. A few minutes on a slow connection.
- `pnpm install` downloads the Electron binary through `apps/desktop`'s `postinstall` (Electron 42+ no longer does it itself). If `pnpm dev:desktop` fails with `Error: Electron uninstall`, run `pnpm --filter @opensquad/desktop exec install-electron`.
- Some IDE terminals export `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. `pnpm dev:desktop` shows no window, and `open release/mac-arm64/OpenSquad.app` exits silently. Prefix with `env -u ELECTRON_RUN_AS_NODE`.
- To pass Electron flags in dev: `pnpm --filter @opensquad/desktop dev -- --remote-debugging-port=9222`. `ELECTRON_EXTRA_LAUNCH_ARGS` is not honored by electron-vite.

## Rules

- Core depends on capabilities, never providers. `agent.sandbox`, not `agent.daytona`.
- Provider SDKs are imported only inside `plugins/<provider>/`. Biome's `noRestrictedImports` fails the build otherwise. Add new SDKs to the list in `biome.json`.
- Postgres is the source of truth. Store provider ids as reference columns (`sandbox_external_id`), never as the only copy of state.
- Plain Postgres only. No Supabase-specific SQL (no `auth.uid()`, RLS tied to Supabase Auth, Realtime). Supabase is a hosted Postgres plus a storage plugin, and must stay swappable.
- One default provider per capability. Do not add alternatives until needed.
- Conversations have `participants[]` from day one. A 1:1 chat is a conversation with two participants.
- Routines are core. Trigger.dev only runs them.
- Never commit `.env` or real keys. `.env.example` holds names only.
- Without `CLERK_SECRET_KEY` the API runs with auth disabled and every request is `dev-user`. Never deploy like that.
- Dependencies: bounded semver, published at least 7 days ago. electron-vite 5 needs Vite 7, not 8.

## Electron rules

- Renderer never touches Node or Electron APIs. `contextIsolation` and `sandbox` stay on, `nodeIntegration` stays off.
- New IPC: add the channel to `shared/ipc.ts`, handle it in `main/ipc.ts` through `handle()` (which checks the sender), expose it in `preload/index.ts`. Never expose `ipcRenderer` itself.
- The CSP in `main/window.ts` is the whitelist for remote hosts. Add to `connect-src` there, not by loosening `default-src`.
- External links go through `shell.openExternal` via the window-open handler. The app never navigates to remote pages.
- Renderer imports from `@opensquad/core` are types only. It is a browser bundle.
