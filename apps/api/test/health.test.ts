import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { createTestApp } from "./helpers.js";

describe("health", () => {
  let app: App;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it("GET / says hello", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("Hello world");
  });

  it("GET /health reports the database is up", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: "up" });
  });
});
