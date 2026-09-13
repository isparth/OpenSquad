# OpenSquad

Open-source agent platform with bring-your-own-key and replaceable capability plugins. The planned product gives each bot a model, computer, memory, email and phone number.

The first runtime is OpenAI Agents API with an OpenAI-hosted environment, behind a provider-neutral runtime interface. Memory, email, phone, tools, scheduling and storage remain separate plugins.

Current state: agent create/list/get/delete endpoints, a desktop health page, local storage, and a transport-tested runtime adapter. Agent editing, conversation persistence, credential onboarding, and desktop chat are still to be built. No live OpenAI integration verification has been performed.

Setup, architecture decisions and conventions: `AGENTS.md`. Local design and execution context: `llm_docs/SPEC.md` and `llm_docs/PLAN.md`.

## Quick start

```text
pnpm install
cp .env.example .env
docker compose up -d --wait
pnpm db:migrate
pnpm dev             # terminal 1: api
pnpm dev:desktop     # terminal 2: electron app
```
