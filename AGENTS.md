# OpenSquad contributor guide

Open-source agent platform with BYOK and replaceable capability plugins. Decision of 2026-09-12: OpenAI Agents API is the first runtime, with `gpt-6-luna` as the default model and an OpenAI-hosted sandbox available per-bot as an opt-in. It replaces the OpenRouter/Daytona defaults, not the independent memory, email, phone, tools, scheduling, or storage capabilities. Core owns product concepts and provider-neutral contracts; plugins implement external capabilities.

Current implementation: agent CRUD/avatars, desktop bot management, local storage, the transport-tested runtime adapter, and the S2a conversation/runtime backend. S2a persists conversations, participants, messages, runs, provider references and replayable product events; it admits input idempotently, observes/cancels/reconciles runtime turns, and streams product SSE. S2b adds development-only encrypted runtime credentials and narrow main-process send/cancel/reconcile IPC; S2c adds the desktop runtime-key panel and per-bot chat (conversation list, streamed thread, cancel/reconcile). Live chat against OpenAI Agents has been exercised once from the desktop (2026-09-20, three succeeded runs). Design and execution context live in `llm_docs/SPEC.md` and `llm_docs/PLAN.md` (gitignored, local only; ask the maintainer if missing). Read their current-decision sections before touching architecture. Their historical OpenRouter/Daytona plans are superseded.

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

Tests hit the real Postgres from docker compose, in a separate `opensquad_test` database that the API test setup creates and migrates (override with `DATABASE_URL`). There is no mock database. Desktop tests run under jsdom with `window.opensquad` stubbed in `apps/desktop/test/setup.ts`.

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
- Start each task on a dedicated feature branch, never directly on main. Make small, focused commits and submit a PR for review. Do not push main or merge a PR automatically. Obtain explicit permission before publishing branches if it has not already been granted.
- Prefer small, focused commits over large combined commits. Keep dependency and lockfile updates with the code that needs them.
- Conversations have `participants[]` from day one. A 1:1 chat is a conversation with two participants.
- Routines are core. Trigger.dev only runs them.
- Never commit `.env` or real keys. `.env.example` holds names only.
- If either `CLERK_SECRET_KEY` or `CLERK_PUBLISHABLE_KEY` is missing, the API runs with auth disabled and every request is `dev-user`. There is no production guard yet. Never deploy like that.
- Dependencies: bounded semver, published at least 7 days ago. electron-vite 5 needs Vite 7, not 8.

## Agent runtime

- Default: `AgentRuntimeProvider` → `plugins/openai-agents`, using OpenAI Agents API for execution and the model. `gpt-6-luna` is the default model. Each bot's Sandbox setting is off by default (`environment: none`); opting in uses an OpenAI-hosted environment. OpenRouter and Daytona are no longer wired into the API.
- `ModelProvider` and `SandboxProvider` remain exported for a future self-managed runtime. Their existing provider packages are unused stubs, not alternative implementations to finish now.
- Product identities, conversations, participants, tasks, runs, routines, permissions, and credentials belong to OpenSquad. Provider sessions and internal subagents are not OpenSquad agents or participants.
- The registry selects one runtime. `RUNTIME_MODEL` configures its default model; callers may select another model supported by that runtime. OpenAI's managed runtime does not accept arbitrary OpenRouter models.
- Every runtime operation takes the user's credentials explicitly. Do not put a user's key in the shared registry or fall back to another user's/server credentials. `OPENAI_API_KEY` is optional local configuration for a future calling service, not an automatic plugin fallback. No key is needed to boot the agent create/list/get/delete scaffold.
- AgentMail, Vapi, Composio, scheduling, and storage remain independent capabilities. Cross-conversation memory is an OpenSquad product feature (S3), not a provider capability. MCP configuration must include an explicit tool allowlist; pass MCP secrets separately in runtime credentials. Subagents are opt-in and bounded.
- S3 M2 extracts from eligible completed messages in older conversations when the first message creates a runtime session, excluding that new conversation. Updates are single-flight per owner and fenced by a lease; expired workers are marked `worker_lost`. Runtime keys are used in memory only and never persisted. Forgetting memory advances source cursors through current conversation sequences so forgotten facts are not reintroduced. `createTestApp` disables auto-trigger by default, and API tests run serially because they share `dev-user` and Postgres.
- Core contracts contain no OpenAI types. Normalize provider events, messages, statuses, and usage inside the plugin. Check runtime feature flags before offering provider-dependent options.
- `CreateRuntimeSessionOptions.environment` defaults to `"hosted"` at contract level; admission always sets it explicitly. `input` is required and non-blank with `"none"`, and rejected for hosted sessions. Runtimes declare environmentless support with `features.environmentless`; admission checks environment feature flags when creating a runtime session, after the drift check.
- `await runtime.events(...)` opens the subscription before resolving. Subscribe before `sendInput` for follow-up input, then consume the stream. Environmentless creation submits its first input with `createSession`, the exception to subscribe-before-send: the worker records the create mutation, subscribes after creation, and adopts the root turn via saved turns/messages (recovery path). Close streams in `finally`, including if sending input fails. A stream ends on a root turn outcome or lifecycle failure. Idle, subagent completion, and disconnection do not mean the root turn succeeded. Closing a stream does not cancel remote work; `cancel` does. `destroySession` deletes provider history and requires an explicit product lifecycle decision.
- Streams do not replay missed events. Recover by opening a new stream, buffering events, and retrieving saved messages and turns. Deduplicate messages by external item ID. Preserve content-part indices and replace text on `message.text.completed`, since deltas are optional.
- OpenAI `command_execution` items normalize to assistant messages with a capped `command` content part; malformed command items are ignored. Environment status comes from the event type (`environment.reset` has no environment payload) and maps to `environment.status` and `runtime_sessions.environment_status`; other non-message items remain ignored.
- When implementing conversation/run services, persist product messages, outcomes, artifacts, and runtime session references in Postgres/storage. Runtime session references must include provider and external ID and be resolved through an ownership-checked service, never trusted from a client. Do not store one provider session directly on the agent row. Switching runtimes starts a new session from product-owned history; hidden execution state and active turns are not portable.
- OpenAI artifacts are collected best-effort from `/workspace/outputs/` for terminal hosted root turns when `features.artifacts` is enabled. Collection is idempotent, retries once after 5 seconds when no artifacts are listed, and is capped at 25 MiB per file, 100 MiB and 20 files per run. Storage keys are opaque `conversations/{conversationId}/files/{fileId}` values and never appear in DTOs. The owner-checked content route serves downloads only as `application/octet-stream` attachments with `nosniff`. Newly created hosted sessions append exactly: `Save files the user should receive under /workspace/outputs.` Environmentless sessions do not.
- Current scope: desktop bot management, agent CRUD/avatars, the runtime adapter, S2a's conversation/run backend, S2b's development-only credential vault, S2c's desktop chat, and S3 M2 automatic memory updates. Text-only chat with a bot works end to end in unpackaged development. S5a Composio app connections exist (tools key, connect/list/disconnect); wiring tools into runtime sessions is S5b. Authenticated desktop identity, production credential storage, and skills/artifact transfer are not implemented yet.
- The OpenAI plugin pins `openai@7.10.0`, published September 3, 2026, to respect the seven-day dependency rule. That release predates Agents API SDK helpers, so the plugin uses public SDK HTTP/SSE methods with local Zod response schemas. Update only this plugin when adopting generated Agents API helpers. Do not replace this integration with the Agents SDK or Responses API.
- Transport reconstructs outbound headers from explicit credentials, ignoring ambient SDK headers, and rejects redirects. Do not remove this isolation: OpenAI SDK 7.10.0 reads `OPENAI_CUSTOM_HEADERS`, which otherwise overrides BYOK authorization and tenant selection. A 60-second adapter deadline bounds complete HTTP operations and SSE establishment, not the duration of an established subscription. Unknown disconnects are errors; explicit local closure/caller abort is separate from remote cancellation.
- Known provider diagnostic codes map to static safe messages; arbitrary nested error text/codes do not leave the plugin. Top-level SSE errors are intercepted by the SDK and become sanitized exceptions, not normalized `runtime.error` events. Unknown/subagent lifecycle events are currently ignored. Session lifecycle events identify the session via `session.id`, unlike turn/text events with top-level `session_id`.
- Runtime adapter tests use a stubbed HTTP transport, not a live OpenAI account. Run `pnpm --filter @opensquad/plugin-openai-agents test` and `pnpm --filter @opensquad/api exec vitest run src/capabilities/registry.test.ts test/production-imports.test.ts` for focused verification. Canonical wire schemas are at https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/stream.md; generic reference links in the guides may return 404.

## Tools (S5a)

- `plugins/composio` calls Composio REST v3.1 over `fetch` with local Zod schemas; no `@composio/core` SDK and no environment reads (the SDK falls back to `COMPOSIO_API_KEY`). Requests carry only the caller's `x-api-key`, reject redirects, time out after 30s and cap bodies at 2 MiB; failures become static `ToolsError` codes. Connected-account schemas pick only id/toolkit/status/is_disabled/created_at, since `state`/`data` can hold tokens. Composio `user_id` is `request.userId`; Composio is the source of truth for connections (no migration).
- The Composio key is BYOK: a second dev-only vault file `tools-key.v1.bin`, sent only by main (`main/tools-commands.ts`) as `X-OpenSquad-Tools-Key` on `/tools/*`, redacted in API logs, never stored server-side. A rejected key is 422 `tools_key_rejected`. Main validates and opens the `https://connect.composio.dev` Connect Link itself; the renderer only sees the connection id.
- Composio silently ignores wrong filter field names and then exposes every tool, including destructive ones. `createSession` (for S5b, not wired yet) therefore verifies the echoed toolkits, per-toolkit tags, workbench/manage-connections/premium flags, the three meta tools and the MCP URL, deleting the session and failing closed with `policy_mismatch` on any difference.
- Focused checks: `pnpm --filter @opensquad/plugin-composio test`, `pnpm --filter @opensquad/api exec vitest run test/tools.test.ts` and `pnpm --filter @opensquad/desktop exec vitest run test/tools-commands.test.ts test/ToolsDialog.test.tsx`.

## Wave 0 decisions (2026-09-15)

P0 is implemented: `buildApp(env, { capabilities?: Partial<Capabilities> })` and `createTestApp(options)` accept trusted construction-time overrides. Supplied instances retain identity; omitted/undefined entries retain defaults. The registry still constructs defaults before merging, so this is not a lazy provider factory. Never populate overrides from HTTP input or put user credentials in a shared provider. The test-only `FakeRuntimeProvider` in `apps/api/test/fakes.ts` fails on unconfigured operations; use typed Vitest scripts and dummy credentials, not a live account. Focused checks: `pnpm --filter @opensquad/api exec vitest run test/capabilities.test.ts test/fakes.test.ts`.

D1–D4 are design decisions, not implemented product features. Full local contracts and sources are in SPEC.md's “Wave 0 decisions”; PLAN.md has a current checklist above its superseded historical plan. Do not execute historical Wave 0 literally.

- D1: conversation/run services belong in API feature modules, own Postgres transactions, and resolve runtime references through ownership checks. No new core tool loop or speculative `RunStore`. Extend scaffold message/run types with the conversation slice.
- D2: JSON command admission (`202`) plus a separate durable product SSE feed. Admission is deduplicated by owner/conversation/client request UUID. Unknown provider outcomes require reconciliation, never blind resubmission. Persist product state/events before publication; provider streams do not replay.
- D2 credentials: narrow Electron-main operations attach `X-OpenSquad-Runtime-Key`; the key-bearing commands include `sendMessage`, `cancelRun`, `reconcileRun` and `refreshMemory`. No plaintext getter or generic renderer-controlled HTTP proxy. OS-protected keys are scoped to user/API origin; reject insecure storage fallback and redirects. Strengthen IPC sender validation before adding credential access. No server-persisted runtime keys.
- D2 lifetime: submission authorizes one root turn across desktop disconnect, with upfront spending disclosure, subagents off by default, and a persisted 10-minute best-effort cancellation deadline. This is not a hard spend cap. API restarts require owner credentials for provider reconciliation/cancellation. Do not report cancellation until confirmed; do not delete sessions as cleanup.
- D3: future per-agent capability rows and durable provisioning attempts; hosted environment state stays session-scoped. MCP destinations/credentials must resolve from owner-checked approved connections. Empty tool approvals omit the server, never allow all tools. No custom core tool execution loop.
- D4: external browser plus short-lived literal-loopback callback, state and PKCE. Reject forged/replayed callbacks and token-bearing URLs. Check Clerk/Composio compatibility and packaged platforms before implementation; do not assume their flows are interchangeable. No protocol registration or auth-flow implementation in Wave 0.

## Conversation runtime backend (S2a)

- Product routes: create/list/get conversations, list messages, admit messages, get/cancel/reconcile runs, and `GET /conversations/:id/events`. All resolve product IDs through owner/membership checks; provider IDs never leave DTOs. `X-OpenSquad-Runtime-Key` is accepted only on send/cancel/reconcile and passed directly to runtime operations; it is redacted from API logs and never persisted.
- Message admission is `202`, keyed by `(conversation_id, client_request_id)`, and permits one active run per conversation. Identical retries return the existing message/run without another provider call; changed payloads are 409. Admission rejects drift in bot instructions, runtime model/provider, or environment with 409; start a new conversation after changing these settings. Limits: 20 new runs/minute and 5 active runs per owner, plus 120 conversation requests/minute outside test mode.
- Run phases distinguish admission, mutation dispatch, observation, cancellation, uncertainty and completion. A provider mutation is recorded before calling out. Never auto-take over a run with `mutation_in_flight`; timeout/abort may mean the provider accepted it. Leases fence stale database writers but cannot revoke an already-sent network request.
- Workers open `runtime.events` before follow-up `sendInput`, buffer while loading a reused session's root-turn baseline, close streams in `finally`, ignore subagent/old-root outcomes, and keep terminal outcomes/content parts monotonic. Environmentless creation submits the first input with `createSession`; after recording the mutation, the worker subscribes and adopts the root turn via saved turns/messages. Output/recovery buffers are byte- and item-bounded. Deadline/output overflow request cancellation but do not claim cancellation until a root outcome is observed.
- Reconciliation opens a new stream before reading saved turns/messages and never resends input. Null provider item IDs are retained in a bounded recovery snapshot and leave the run active with `history_requires_review`. A disconnected/expired observer becomes `reconciliation_required`; recovery failures do not free the admission slot.
- Product SSE reads only Postgres state and requires no runtime key. It sends snapshots for new subscribers, replays strictly after decimal-string `Last-Event-ID`, resets expired/gapped cursors, uses comments for caught-up/heartbeat traffic, and destroys its dedicated HTTP socket on unsubscribe/shutdown. Product events are serialized per conversation by the locked sequence counter transaction.
- Production API startup now requires both Clerk keys; missing either fails closed. `dev-user` remains test/development only. Bot deletion is 409 while any associated run is active; otherwise participant name/ref snapshots remain with `deletedAt`, and provider sessions are not deleted.
- Migration `0001_sturdy_mercury.sql` adds conversation/run storage. Migration `0002_thankful_excalibur.sql` adds memory documents/revisions and `runtime_sessions.memory_snapshot`. Migration `0003_confused_wiccan.sql` adds the per-bot sandbox preference and `runtime_sessions.environment`; its `hosted` DB default backfills legacy sessions and supports older checkouts, while admission always writes the selected environment explicitly. Migration `0004_previous_shaman.sql` adds memory update jobs, source cursors, settings, and revision update references. Migration `0005_rare_annihilus.sql` drops the unused `agents.memory_external_id` column. Run `pnpm db:migrate` before S2a tests. Focused checks: `pnpm --filter @opensquad/api exec vitest run test/conversations.test.ts test/run-admission.test.ts test/runtime-persistence.test.ts test/runs.test.ts test/conversation-events.test.ts test/runtime-safety.test.ts`.
- Official sources: OpenAI session events https://developers.openai.com/api/docs/guides/agents-api/sessions/events ; PostgreSQL locking https://www.postgresql.org/docs/16/explicit-locking.html ; Drizzle transactions https://orm.drizzle.team/docs/transactions ; Fastify reply streams https://fastify.dev/docs/latest/Reference/Reply/ . Tests use a fake runtime and real Postgres; no live provider verification has been performed.

## Bot management (S1)

- `PATCH /agents/:id` accepts only name, label, description, instructions and `sandboxEnabled`. Blank/null labels clear to null; omitted fields are preserved. SQL advances updatedAt by at least one millisecond, including back-to-back edits.
- Avatars: one multipart `avatar` file, max 2 MiB, single-frame PNG/JPEG/WebP, max 4 million pixels. Sharp validates decoding with a five-second processing timeout; PNG acTL chunks are explicitly rejected because the decoder can otherwise read just the first APNG frame. Original bytes/metadata are preserved, not re-encoded.
- avatarUrl is a versioned relative product path, not an expiring provider URL. `/agents/:id/avatar/:file` requires ownership/current-version checks and reads through capabilities.storage. Do not add a generic public `/storage/*` handler. The renderer fetches images via ApiClient, uses blob URLs and revokes them.
- Avatar replacement locks the agent row; cleanup of replaced/deleted avatars is best-effort with safe logs. Unknown DB commit failures retain uploaded objects for reconciliation. Bot deletion does not delete provider resources. Decide conversation participant/history retention before adding conversations.
- Desktop bot UI is in `features/agents`; API status remains visible. CORS explicitly allows GET/HEAD/POST/PATCH/DELETE (S1 maintainer-approved method change); origin policy is unchanged and still needs production hardening.
- Focused tests: `pnpm --filter @opensquad/api exec vitest run test/agents-edit.test.ts test/avatars.test.ts` and `pnpm --filter @opensquad/desktop exec vitest run test/BotsPage.test.tsx test/ApiClient.test.tsx`.
- Audit follow-up recorded 2026-09-15: existing drizzle-orm 0.44.7 has GHSA-gpj5-g38j-94v9 (high); current queries use static identifiers and parameterized values, not attacker-controlled identifiers/aliases. Existing esbuild 0.18.20 and Vitest/@vitest/mocker 3.2.7 also have moderate advisories. No new avatar dependency was flagged. Review dependency upgrades before hosting/release; audit is not clean.

## Electron rules

- Renderer never touches Node or Electron APIs. `contextIsolation` and `sandbox` stay on, `nodeIntegration` stays off.
- New IPC: add the channel to `shared/ipc.ts`, handle it in `main/ipc.ts` through `handle()` (which checks the sender), expose it in `preload/index.ts`. Never expose `ipcRenderer` itself.
- The CSP in `main/window.ts` is the whitelist for remote hosts. Add to `connect-src` there, not by loosening `default-src`.
- External links go through `shell.openExternal` via the window-open handler. The app never navigates to remote pages.
- Renderer imports from `@opensquad/core` are types only. It is a browser bundle.

## Desktop runtime credentials (S2b)

- `main/runtime-credentials.ts` is an injectable vault over Electron `safeStorage` (async API only). Persistence is enabled solely when `is.dev && !app.isPackaged` and `OPENSQUAD_API_URL` is an origin-only `http:` loopback URL (`localhost`, `127.0.0.1`, `[::1]`); subject is fixed `dev-user`. Packaged/production status and key-bearing commands fail with `authentication-required`; no env flag overrides `app.isPackaged`. The vault file `runtime-key.v1.bin` holds ciphertext only (`{version,subject,origin,key}`); records bound to another origin report `origin-changed` and are never sent. Corrupt storage requires an explicit delete before a new `set`. Writes go through a random exclusive `0600` temp file, fsync, rename, and directory fsync.
- Accepted development-only trade-off: at-rest protection semantics vary by platform and backend, and safeStorage is not guaranteed fresh per-use authentication or a complete same-user process boundary. Sending the key to whichever process owns the loopback port remains an accepted risk. The single-instance lock bounds this app's own configured userData races but is not an OS authentication or malicious-process boundary. Production storage stays disabled until authenticated process identity plus HTTPS/service identity exist.
- `main/runtime-commands.ts` is the only key consumer: fixed POST routes (`/conversations/:id/messages`, `/runs/:id/cancel`, `/runs/:id/reconcile`), headers limited to `Content-Type` and `X-OpenSquad-Runtime-Key`, `redirect:"error"`, 60s timeout merged with the caller signal, no retries, `clientRequestId` preserved verbatim. Admission limits: 4 active commands and 60 credential-bearing commands/minute; responses must be `application/json`, capped at 1 MiB streamed, then strict-Zod parsed. Non-2xx statuses map to static categories — 400 `request rejected`, 401/403 `authentication required`, 404 `resource not found`, 409 `request conflict`, 429 `rate limited`, other `service unavailable` — with the response body cancelled first. Renderer-facing errors are static strings; key/body/URL/provider text never crosses IPC. The backend remains authoritative for owner, rate, and idempotency checks.
- IPC hardening in `main/ipc.ts`: trust is granted only by `controller.trustWindow` to main-created webContents (removed on `destroyed`), `senderFrame` must be the sender's `mainFrame`, and `main/renderer-url.ts` compares the parsed frame URL to the exact canonical renderer document (when `ELECTRON_RENDERER_URL` is set it must itself be an origin-only `http:` loopback URL, else nothing is trusted; when absent the expected document is `file://` `out/renderer/index.html` in both dev and packaged; credentials/query/hash rejected on candidates). Main-frame navigation start and destroy abort that webContents' in-flight requests; trust is rechecked after every await. Per-webContents invoke limit: 120/minute; vault status reads are additionally limited to 60/minute globally and vault mutations (set/delete) to 10/minute, so status polling cannot starve credential changes. Vault operations are not abortable mid-safeStorage: Electron's safeStorage calls are not cancellable or time-bounded, and a hung OS keychain/backend can require an app restart. `app.requestSingleInstanceLock()` gates startup; `will-quit` aborts active commands.
- Sources/limits: Electron 42 `safeStorage` docs (async methods, `isEncryptionAvailable` after ready, Linux `basic_text`/`unknown` = unprotected, `decryptStringAsync` returns `{result, shouldReEncrypt}`); `ipcMain.handle` serializes only `error.message` to the renderer; `event.senderFrame` may be null and `WebContents.mainFrame` is canonical. Tests mock Electron/fetch; no real provider call or real credential is used. Verifying real OS keychain behavior needs a packaged/dev Electron run — e.g. a script that calls `safeStorage.isEncryptionAvailable()`, `isAsyncEncryptionAvailable()`, `getSelectedStorageBackend()`, and round-trips `encryptStringAsync`/`decryptStringAsync` — left as a lead-side diagnostic.

## Desktop chat (S2c)

- `GET /me` (`modules/me/routes.ts`) returns `{ userId }` behind `requireAuth` so the renderer can build the `participants[]` for `POST /conversations`; `GET /conversations?agentId=` filters by the agent participant. The desktop `ApiClient` caches `/me` per client and validates every conversation/message payload by hand (no zod in the renderer).
- `features/chat/thread-state.ts` is the pure reducer over product SSE events; `useConversationStream` feeds it from a native `EventSource` on the credential-free `/conversations/:id/events` route. Browser reconnects carry `Last-Event-ID`; the server's `stream.reset` + fresh snapshot handles expired cursors. A closed stream renders as "Live updates disconnected" with a Reconnect button, never as run failure. One `EventSource` per open thread — the API caps an owner at five.
- Send/cancel/reconcile go through `window.opensquad` only (S2b IPC); reads and SSE are plain fetch/EventSource. `crypto.randomUUID()` is generated once per send intent; Retry reuses the same `clientRequestId` and text, Discard drops it. `Thread` is keyed by conversation id so draft/pending state cannot leak between conversations. Reconcile is offered only for the active run when `observation === "reconciliation_required"` or the error code is `uncertain_mutation`/`worker_lost`/`stream_disconnected`.
- The runtime-key dialog (`features/runtime-key/`) shows static copy per `RuntimeKeyStatus` reason, clears the password field after every save attempt, and never receives the key back. `RuntimeKeyProvider` wraps the app; `BotsPage` tests must render inside it.
- Verification: jsdom tests with a fake `EventSource` (`test/fake-event-source.ts`) and stubbed fetch; a real Electron dev run against a local API booted with a scripted fake runtime on another port (create → send → stream → cancel → reload → remove key); then one manual live session against OpenAI Agents from the desktop. Terminal turn events and the first saved-turn read report null usage; OpenAI fills it into the saved turn about 3s later, so the API re-reads the saved turn (chat runs: after release, best-effort; memory updates: before apply); `createTestApp` disables this unless a test opts in.

## Memory (S3 M1)

- Three markdown documents per user in Postgres (`memory_documents` plus append-only `memory_revisions`, latest 50 kept): `profile` and `preferences` are shared by all of an owner's bots; `notes` is per bot and cascades on bot deletion. Limits are 4,000 / 2,000 / 4,000 characters. `modules/memory` owns the routes and service. Every write takes `expectedVersion` (409 on mismatch) under a per-owner advisory lock and records a revision. `DELETE /memory` hard-deletes all of the owner's memory, including history. Saving uses PATCH because the CORS method list excludes PUT.
- Injection: admission renders memory into `runtime_sessions.memory_snapshot` when a conversation's session row is first inserted, and the worker sends `instructions + "\n\n" + snapshot` (`modules/memory/render.ts`). Memory is frozen per conversation; the drift 409 still compares only base instructions. Never prepend memory to user input: saved-input verification requires the provider's user text to equal the admitted input.
- M1 has no model-driven extraction; users edit memory in the bot profile's Memory panel (`features/memory`). Extraction (M2) and review (M3) are specified in SPEC.md "S3 — Memory".
- M3 reviews each successful changed update independently: Keep marks it reviewed; Undo atomically restores all changed documents only when every document remains at its update's `toVersion` and each previous revision is available. Shared profile/preferences reviews are relevant in every bot's Memory panel; notes remain scoped to the bot that produced the update. Undo never rewinds `memory_sources`. Failed, reviewed, and no-change updates older than 30 days are pruned; old unreviewed changed updates are retained. The desktop review list renders accessible line diffs; Keep/Undo quietly refetches documents and the pending count without replacing the panel or clearing drafts.
- Focused checks: `pnpm --filter @opensquad/api exec vitest run test/memory.test.ts src/modules/memory/render.test.ts` and `pnpm --filter @opensquad/desktop exec vitest run test/MemoryPanel.test.tsx test/ApiClient.test.tsx`.
