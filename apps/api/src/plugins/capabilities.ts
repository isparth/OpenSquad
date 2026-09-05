import type { Capabilities } from "@opensquad/core";
import fp from "fastify-plugin";
import { buildCapabilities } from "../capabilities/registry.js";

declare module "fastify" {
  interface FastifyInstance {
    capabilities: Capabilities;
  }
}

export default fp(
  async (app) => {
    app.decorate("capabilities", buildCapabilities(app.env));
  },
  { name: "capabilities", dependencies: ["env"] },
);
