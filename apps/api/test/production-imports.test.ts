import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("production workspace imports", () => {
  it("ships the TypeScript loader used for source-exporting workspace dependencies", () => {
    expect(manifest.dependencies.tsx).toBeDefined();
    expect(manifest.devDependencies.tsx).toBeUndefined();
  });

  it("loads runtime and database packages with the production start flags", () => {
    const [node, ...args] = manifest.scripts.start.split(" ");
    expect(node).toBe("node");
    expect(args.pop()).toBe("dist/server.js");
    const result = spawnSync(
      process.execPath,
      [
        ...args.filter((arg: string) => !arg.startsWith("--env-file")),
        "--input-type=module",
        "--eval",
        'const { OpenAIAgentsProvider } = await import("@opensquad/plugin-openai-agents"); const { agents } = await import("@opensquad/db"); if (new OpenAIAgentsProvider().name !== "openai-agents" || !agents) process.exit(1);',
      ],
      { cwd: apiDirectory, env: { TSX_DISABLE_CACHE: "1" }, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
