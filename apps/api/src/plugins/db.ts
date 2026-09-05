import { createDatabase, type Database } from "@opensquad/db";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

export default fp(
  async (app) => {
    const { db, close } = createDatabase(app.env.DATABASE_URL);
    app.decorate("db", db);
    app.addHook("onClose", close);
  },
  { name: "db", dependencies: ["env"] },
);
