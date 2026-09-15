import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { agents } from "@opensquad/db";
import { LocalStorageProvider } from "@opensquad/plugin-local-storage";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { agentsService } from "../src/modules/agents/service.js";
import { FakeRuntimeProvider } from "./fakes.js";
import { createTestApp } from "./helpers.js";

const maxBytes = 2 * 1024 * 1024;
const boundary = "opensquad-test-boundary";
function multipart(files: Array<{ data: Buffer; type: string; name?: string }>) {
  return Buffer.concat([
    ...files.flatMap(({ data, type, name = "avatar" }) => [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="../../untrusted"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      data,
      Buffer.from("\r\n"),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

describe("private agent avatars", () => {
  let app: App;
  let root: string;
  let storage: LocalStorageProvider;
  let png: Buffer;
  const created: string[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "opensquad-avatars-"));
    storage = new LocalStorageProvider({ rootDir: root, publicBaseUrl: "http://localhost:3000" });
    app = await createTestApp({ capabilities: { storage, runtime: new FakeRuntimeProvider() } });
    png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of created.splice(0)) await app.db.delete(agents).where(eq(agents.id, id));
  });
  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  async function seed(ownerId = "dev-user") {
    const agent = await agentsService(app.db).create({ ownerId, name: "Avatar test" });
    created.push(agent.id);
    return agent;
  }
  function upload(id: string, data = png, type = "image/png", name = "avatar") {
    return app.inject({
      method: "POST",
      url: `/agents/${id}/avatar`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart([{ data, type, name }]),
    });
  }
  function key(id: string, url: string) {
    return `avatars/${id}/${url.split("/").at(-1)}`;
  }

  it.each(["png", "jpeg", "webp"] as const)(
    "stores and serves identical %s bytes with private headers",
    async (format) => {
      const agent = await seed();
      const bytes = await sharp(png).toFormat(format).toBuffer();
      const response = await upload(agent.id, bytes, `image/${format}`);
      expect(response.statusCode).toBe(200);
      const { avatarUrl } = response.json();
      expect(avatarUrl).toMatch(new RegExp(`^/agents/${agent.id}/avatar/[0-9a-f-]+\\.${format}$`));
      expect((await agentsService(app.db).get("dev-user", agent.id))?.avatarUrl).toBe(avatarUrl);
      const downloaded = await app.inject({ method: "GET", url: avatarUrl });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload).toEqual(bytes);
      expect(downloaded.headers["content-type"]).toBe(`image/${format}`);
      expect(downloaded.headers["cache-control"]).toBe("private, no-store");
      expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    },
  );

  it("accepts the exact byte limit but rejects oversized files without changing the avatar", async () => {
    const agent = await seed();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const exact = Buffer.concat([jpeg, Buffer.alloc(maxBytes - jpeg.length)]);
    expect((await upload(agent.id, exact, "image/jpeg")).statusCode).toBe(200);
    const previous = await agentsService(app.db).get("dev-user", agent.id);
    expect((await upload(agent.id, Buffer.alloc(maxBytes + 1))).statusCode).toBe(400);
    expect(await agentsService(app.db).get("dev-user", agent.id)).toEqual(previous);
  });

  it.each([
    ["image/png", Buffer.from("not an image")],
    ["image/png", Buffer.alloc(0)],
    ["image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["text/plain", Buffer.from("plain text")],
  ])("rejects unsupported or corrupt data (%#)", async (type, data) => {
    const agent = await seed();
    expect((await upload(agent.id, data as Buffer, type as string)).statusCode).toBe(400);
    expect((await agentsService(app.db).get("dev-user", agent.id))?.avatarUrl).toBeNull();
  });

  it("rejects MIME mismatches, truncated pixel data and excessive dimensions", async () => {
    const agent = await seed();
    expect((await upload(agent.id, png, "image/jpeg")).statusCode).toBe(400);
    expect((await upload(agent.id, png.subarray(0, 40))).statusCode).toBe(400);
    const huge = await sharp({
      create: { width: 2001, height: 2000, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    expect((await upload(agent.id, huge)).statusCode).toBe(400);
  });

  it("rejects PNG animation declarations even when the decoder only reads its first frame", async () => {
    const agent = await seed();
    const control = Buffer.alloc(20);
    control.writeUInt32BE(8, 0);
    control.write("acTL", 4);
    control.writeUInt32BE(2, 8);
    control.writeUInt32BE(crc32(control.subarray(4, 16)), 16);
    const animated = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
    expect((await upload(agent.id, animated)).statusCode).toBe(400);
  });

  it("rejects missing files, unexpected fields and multiple files", async () => {
    const agent = await seed();
    expect((await upload(agent.id, png, "image/png", "wrong-field")).statusCode).toBe(400);
    for (const files of [
      [],
      [
        { data: png, type: "image/png" },
        { data: png, type: "image/png" },
      ],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/agents/${agent.id}/avatar`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart(files),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (await app.inject({ method: "POST", url: `/agents/${agent.id}/avatar`, payload: {} }))
        .statusCode,
    ).toBe(400);
  });

  it("denies other-owner/missing agents before storage access and rejects arbitrary paths", async () => {
    const other = await seed("other-user");
    const put = vi.spyOn(storage, "put");
    const get = vi.spyOn(storage, "get");
    for (const id of [other.id, randomUUID()]) {
      expect((await upload(id)).statusCode).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: `/agents/${id}/avatar/${randomUUID()}.png` }))
          .statusCode,
      ).toBe(404);
    }
    expect(
      (await app.inject({ method: "GET", url: `/agents/${other.id}/avatar/..%2Fsecret` }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/storage/secret" })).statusCode).toBe(404);
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("replaces versions and deletes only the current agent/avatar, not provider state", async () => {
    const agent = await seed();
    const first = (await upload(agent.id)).json().avatarUrl;
    const second = (await upload(agent.id)).json().avatarUrl;
    expect(second).not.toBe(first);
    expect(await storage.get(key(agent.id, first))).toBeNull();
    expect((await app.inject({ method: "GET", url: first })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/agents/${agent.id}` })).statusCode).toBe(
      204,
    );
    expect(await storage.get(key(agent.id, second))).toBeNull();
    expect((await app.inject({ method: "GET", url: second })).statusCode).toBe(404);
  });

  it("keeps a committed avatar when storage writes fail", async () => {
    const agent = await seed();
    await upload(agent.id);
    const previous = await agentsService(app.db).get("dev-user", agent.id);
    vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await upload(agent.id)).statusCode).toBe(500);
    expect(await agentsService(app.db).get("dev-user", agent.id)).toEqual(previous);
  });

  it("does not roll back a committed avatar or bot deletion when cleanup fails", async () => {
    const agent = await seed();
    await upload(agent.id);
    vi.spyOn(storage, "delete").mockRejectedValue(new Error("Cleanup failed"));
    const response = await upload(agent.id);
    expect(response.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: response.json().avatarUrl })).rawPayload,
    ).toEqual(png);
    expect((await app.inject({ method: "DELETE", url: `/agents/${agent.id}` })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: "GET", url: response.json().avatarUrl })).statusCode).toBe(
      404,
    );
  });

  it("cleans the new object if the agent is deleted during upload", async () => {
    const agent = await seed();
    const put = storage.put.bind(storage);
    const write = vi.spyOn(storage, "put").mockImplementationOnce(async (...args) => {
      const result = await put(...args);
      await agentsService(app.db).delete("dev-user", agent.id);
      return result;
    });
    expect((await upload(agent.id)).statusCode).toBe(404);
    const storedKey = write.mock.calls[0]?.[0];
    expect(storedKey).toBeDefined();
    expect(await storage.get(storedKey as string)).toBeNull();
  });

  it("denies access after ownership changes and sanitizes storage read failures", async () => {
    const agent = await seed();
    const avatarUrl = (await upload(agent.id)).json().avatarUrl;
    vi.spyOn(storage, "get").mockRejectedValueOnce(new Error("private storage diagnostic"));
    const failed = await app.inject({ method: "GET", url: avatarUrl });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("private storage diagnostic");
    await app.db.update(agents).set({ ownerId: "other-user" }).where(eq(agents.id, agent.id));
    expect((await app.inject({ method: "GET", url: avatarUrl })).statusCode).toBe(404);
  });

  it("serializes concurrent replacement without deleting the winning image", async () => {
    const agent = await seed();
    const responses = await Promise.all([upload(agent.id), upload(agent.id)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const current = (await agentsService(app.db).get("dev-user", agent.id))?.avatarUrl as string;
    expect((await app.inject({ method: "GET", url: current })).rawPayload).toEqual(png);
    const old = responses.map((r) => r.json().avatarUrl).find((url) => url !== current);
    expect(await storage.get(key(agent.id, old))).toBeNull();
  });
});
