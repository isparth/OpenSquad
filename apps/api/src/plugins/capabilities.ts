import type { Capabilities } from "@opensquad/core";
import fp from "fastify-plugin";
import { buildCapabilities } from "../capabilities/registry.js";

declare module "fastify" {
  interface FastifyInstance {
    capabilities: Capabilities;
  }
}

export default fp(
  async (app, options: { overrides?: Partial<Capabilities> }) => {
    const overrides = Object.fromEntries(
      Object.entries(options.overrides ?? {}).filter(([, provider]) => provider !== undefined),
    );
    app.decorate("capabilities", { ...buildCapabilities(app.env), ...overrides });
  },
  { name: "capabilities", dependencies: ["env"] },
);
