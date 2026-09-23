import { randomUUID } from "node:crypto";
import { agents } from "@opensquad/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { createTestApp } from "./helpers.js";

describe("agent editing", () => {
  let app: App;
  const created: string[] = [];
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    for (const id of created.splice(0)) await app.db.delete(agents).where(eq(agents.id, id));
  });
  afterAll(() => app.close());

  async function seed(ownerId = "dev-user") {
    const agent = await agentsService(app.db).create({
      ownerId,
      name: "Alice",
      label: "Research",
      description: "A researcher",
      instructions: "Cite sources",
    });
    created.push(agent.id);
    return agent;
  }

  it("persists partial updates, preserves omitted fields and advances timestamps on rapid edits", async () => {
    const agent = await seed();
    let previous = agent.updatedAt.getTime();
    for (const name of ["  Alice edited  ", "Alice again"]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agent.id}`,
        payload: { name },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        name: name.trim(),
        label: "Research",
        description: "A researcher",
        instructions: "Cite sources",
      });
      expect(body).not.toHaveProperty("ownerId");
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(previous);
      previous = new Date(body.updatedAt).getTime();
    }
    const row = await agentsService(app.db).get("dev-user", agent.id);
    expect(row?.name).toBe("Alice again");
    expect(row?.updatedAt.getTime()).toBe(previous);
  });

  it.each([null, "", "   "])(
    "clears a label with %j and accepts empty optional text",
    async (label) => {
      const agent = await seed();
      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agent.id}`,
        payload: { label, description: "", instructions: "" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        name: "Alice",
        label: null,
        description: "",
        instructions: "",
      });
    },
  );

  it.each([
    {},
    { name: "" },
    { name: "   " },
    { name: "a".repeat(101) },
    { label: "a".repeat(51) },
    { description: "a".repeat(2001) },
    { instructions: "a".repeat(20001) },
    { sandboxEnabled: "true" },
    { sandboxEnabled: 1 },
    { name: null },
    { ownerId: "someone-else" },
    { avatarUrl: "https://invalid.example/image" },
    { name: "Changed", ownerId: "someone-else" },
  ])("rejects invalid or unsupported edits (%#)", async (payload) => {
    const agent = await seed();
    const response = await app.inject({ method: "PATCH", url: `/agents/${agent.id}`, payload });
    expect(response.statusCode).toBe(400);
    expect(await agentsService(app.db).get("dev-user", agent.id)).toEqual(agent);
  });

  it("toggles sandbox by itself and advances updatedAt", async () => {
    const agent = await seed();
    let previousUpdatedAt = agent.updatedAt.getTime();
    for (const sandboxEnabled of [true, false]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agent.id}`,
        payload: { sandboxEnabled },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().sandboxEnabled).toBe(sandboxEnabled);
      expect(new Date(response.json().updatedAt).getTime()).toBeGreaterThan(previousUpdatedAt);
      previousUpdatedAt = new Date(response.json().updatedAt).getTime();
    }
  });

  it("returns 404 for missing and other-owner agents without modifying them", async () => {
    const other = await seed("other-user");
    for (const id of [randomUUID(), other.id]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${id}`,
        payload: { name: "No" },
      });
      expect(response.statusCode).toBe(404);
    }
    expect(await agentsService(app.db).get("other-user", other.id)).toEqual(other);
  });

  it.each(["PATCH", "DELETE"])("allows browser preflight for %s", async (method) => {
    const response = await app.inject({
      method: "OPTIONS",
      url: `/agents/${randomUUID()}`,
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": method,
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["access-control-allow-methods"]).split(/,\s*/)).toContain(
      method,
    );
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("rejects malformed IDs and whitespace-only names on creation", async () => {
    expect(
      (await app.inject({ method: "PATCH", url: "/agents/not-a-uuid", payload: { name: "No" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/agents", payload: { name: "   " } })).statusCode,
    ).toBe(400);
  });
});
