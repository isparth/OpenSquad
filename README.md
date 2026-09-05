# OpenSquad

Open-source agent platform with bring-your-own-key. Each bot gets its own model, computer, memory, email and phone number.

Design: `llm_docs/SPEC.md`. Setup and conventions: `AGENTS.md`.

## Quick start

```text
pnpm install
cp .env.example .env
docker compose up -d --wait
pnpm db:migrate
pnpm dev             # terminal 1: api
pnpm dev:desktop     # terminal 2: electron app
```
