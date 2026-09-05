import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { createTestApp } from "./helpers.js";

describe("agents", () => {
  let app: App;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it("creates, reads and deletes an agent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { name: "Alice", description: "Test agent", instructions: "Be helpful." },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent).toMatchObject({ name: "Alice", description: "Test agent", label: null });

    const fetched = await app.inject({ method: "GET", url: `/agents/${agent.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().id).toBe(agent.id);

    const listed = await app.inject({ method: "GET", url: "/agents" });
    expect(listed.json().some((a: { id: string }) => a.id === agent.id)).toBe(true);

    const deleted = await app.inject({ method: "DELETE", url: `/agents/${agent.id}` });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({ method: "GET", url: `/agents/${agent.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it("rejects an agent without a name", async () => {
    const res = await app.inject({ method: "POST", url: "/agents", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
  });
});
