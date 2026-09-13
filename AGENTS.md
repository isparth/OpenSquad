# OpenSquad contributor guide

Open-source agent platform with BYOK and replaceable capability plugins. Decision of 2026-09-12: OpenAI Agents API is the first runtime, including its model and OpenAI-hosted environment. It replaces the OpenRouter/Daytona defaults, not the independent memory, email, phone, tools, scheduling, or storage capabilities. Core owns product concepts and provider-neutral contracts; plugins implement external capabilities.

Current implementation: agent create/list/get/delete endpoints, a desktop health page, local storage, and a transport-tested runtime adapter. Agent editing, conversation/run persistence, credential onboarding, and desktop execution are not implemented. Design and execution context live in `llm_docs/SPEC.md` and `llm_docs/PLAN.md` (gitignored, local only; ask the maintainer if missing). Read their current-decision sections before touching architecture. Their historical OpenRouter/Daytona plans are superseded.

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
capabilities/registry  selects each capability's plugin. Provider migration also needs package/config and feature review.
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

Workspace packages currently export TypeScript source. The compiled API still imports these packages, so production start uses `node --import tsx` and `tsx` must remain a production dependency. Do not replace it with plain Node unless workspace packages are compiled/exported consistently. `test/production-imports.test.ts` checks the actual start flags against runtime and database imports without loading `.env` or making provider/database requests.

Things that look wrong but aren't:

- `pnpm db:migrate` prints Postgres NOTICE objects (`schema "drizzle" already exists`) on re-runs. Harmless. "migrations applied" at the end is the signal.
- The first `package` run downloads an Electron zip. A few minutes on a slow connection.
- `pnpm install` downloads the Electron binary through `apps/desktop`'s `postinstall` (Electron 42+ no longer does it itself). If `pnpm dev:desktop` fails with `Error: Electron uninstall`, run `pnpm --filter @opensquad/desktop exec install-electron`.
- Some IDE terminals export `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. `pnpm dev:desktop` shows no window, and `open release/mac-arm64/OpenSquad.app` exits silently. Prefix with `env -u ELECTRON_RUN_AS_NODE`.
- To pass Electron flags in dev: `pnpm --filter @opensquad/desktop dev -- --remote-debugging-port=9222`. `ELECTRON_EXTRA_LAUNCH_ARGS` is not honored by electron-vite.

## Rules

- Core depends on capabilities, never providers. Product services call `capabilities.runtime`, not OpenAI sessions directly. The model/sandbox interfaces are retained for future self-managed runtimes, not the active execution path.
- Provider SDKs are imported only inside `plugins/<provider>/`. Biome's `noRestrictedImports` checks listed package roots during `pnpm lint`; it is not a complete architectural dependency check and does not run as part of `pnpm build`. Review SDK subpath imports and core dependencies too. Add new SDKs to the list in `biome.json`.
- Postgres is the source of truth. Store provider ids as reference columns (`sandbox_external_id`), never as the only copy of state.
- Plain Postgres only. No Supabase-specific SQL (no `auth.uid()`, RLS tied to Supabase Auth, Realtime). Supabase is a hosted Postgres plus a storage plugin, and must stay swappable.
- One default provider per capability. Do not add alternatives until needed.
- Prefer small, focused commits over large combined commits. Keep dependency and lockfile updates with the code that needs them.
- Conversations have `participants[]` from day one. A 1:1 chat is a conversation with two participants.
- Routines are core. Trigger.dev only runs them.
- Never commit `.env` or real keys. `.env.example` holds names only.
- If either `CLERK_SECRET_KEY` or `CLERK_PUBLISHABLE_KEY` is missing, the API runs with auth disabled and every request is `dev-user`. There is no production guard yet. Never deploy like that.
- Dependencies: bounded semver, published at least 7 days ago. electron-vite 5 needs Vite 7, not 8.

## Agent runtime

- Default: `AgentRuntimeProvider` → `plugins/openai-agents`, using OpenAI Agents API for execution, the model, and an OpenAI-hosted environment. OpenRouter and Daytona are no longer wired into the API.
- `ModelProvider` and `SandboxProvider` remain exported for a future self-managed runtime. Their existing provider packages are unused stubs, not alternative implementations to finish now.
- Product identities, conversations, participants, tasks, runs, routines, permissions, and credentials belong to OpenSquad. Provider sessions and internal subagents are not OpenSquad agents or participants.
- The registry selects one runtime. `RUNTIME_MODEL` configures its default model; callers may select another model supported by that runtime. OpenAI's managed runtime does not accept arbitrary OpenRouter models.
- Every runtime operation takes the user's credentials explicitly. Do not put a user's key in the shared registry or fall back to another user's/server credentials. `OPENAI_API_KEY` is optional local configuration for a future calling service, not an automatic plugin fallback. No key is needed to boot the agent create/list/get/delete scaffold.
- Mem0, AgentMail, Vapi, Composio, scheduling, and storage remain independent capabilities. MCP configuration must include an explicit tool allowlist; pass MCP secrets separately in runtime credentials. Subagents are opt-in and bounded.
- Core contracts contain no OpenAI types. Normalize provider events, messages, statuses, and usage inside the plugin. Check runtime feature flags before offering provider-dependent options.
- `await runtime.events(...)` opens the subscription before resolving. Subscribe before `sendInput`, then consume the stream; close it in a `finally` block, including if sending input fails. A stream ends on a root turn outcome or lifecycle failure. Idle, subagent completion, and disconnection do not mean the root turn succeeded. Closing a stream does not cancel remote work; `cancel` does. `destroySession` deletes provider history and requires an explicit product lifecycle decision.
- Streams do not replay missed events. Recover by opening a new stream, buffering events, and retrieving saved messages and turns. Deduplicate messages by external item ID. Preserve content-part indices and replace text on `message.text.completed`, since deltas are optional.
- When implementing conversation/run services, persist product messages, outcomes, artifacts, and runtime session references in Postgres/storage. Runtime session references must include provider and external ID and be resolved through an ownership-checked service, never trusted from a client. Do not store one provider session directly on the agent row. Switching runtimes starts a new session from product-owned history; hidden execution state and active turns are not portable.
- Current scope: agent create/list/get/delete plus the runtime adapter. Agent editing, conversation/run persistence, credential onboarding, authenticated Composio MCP provisioning, skills/artifact transfer, and desktop execution UI are not implemented yet. Do not call this end-to-end agent chat.
- The OpenAI plugin pins `openai@7.10.0`, published September 3, 2026, to respect the seven-day dependency rule. That release predates Agents API SDK helpers, so the plugin uses public SDK HTTP/SSE methods with local Zod response schemas. Update only this plugin when adopting generated Agents API helpers. Do not replace this integration with the Agents SDK or Responses API.
- Transport reconstructs outbound headers from explicit credentials, ignoring ambient SDK headers, and rejects redirects. Do not remove this isolation: OpenAI SDK 7.10.0 reads `OPENAI_CUSTOM_HEADERS`, which otherwise overrides BYOK authorization and tenant selection. A 60-second adapter deadline bounds complete HTTP operations and SSE establishment, not the duration of an established subscription. Unknown disconnects are errors; explicit local closure/caller abort is separate from remote cancellation.
- Known provider diagnostic codes map to static safe messages; arbitrary nested error text/codes do not leave the plugin. Top-level SSE errors are intercepted by the SDK and become sanitized exceptions, not normalized `runtime.error` events. Unknown/subagent lifecycle events are currently ignored. Session lifecycle events identify the session via `session.id`, unlike turn/text events with top-level `session_id`.
- Runtime adapter tests use a stubbed HTTP transport, not a live OpenAI account. Run `pnpm --filter @opensquad/plugin-openai-agents test` and `pnpm --filter @opensquad/api exec vitest run src/capabilities/registry.test.ts test/production-imports.test.ts` for focused verification. Canonical wire schemas are at https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/stream.md; generic reference links in the guides may return 404.

## Electron rules

- Renderer never touches Node or Electron APIs. `contextIsolation` and `sandbox` stay on, `nodeIntegration` stays off.
- New IPC: add the channel to `shared/ipc.ts`, handle it in `main/ipc.ts` through `handle()` (which checks the sender), expose it in `preload/index.ts`. Never expose `ipcRenderer` itself.
- The CSP in `main/window.ts` is the whitelist for remote hosts. Add to `connect-src` there, not by loosening `default-src`.
- External links go through `shell.openExternal` via the window-open handler. The app never navigates to remote pages.
- Renderer imports from `@opensquad/core` are types only. It is a browser bundle.
