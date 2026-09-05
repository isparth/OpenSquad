import type { Capabilities } from "@opensquad/core";
import { AgentMailProvider } from "@opensquad/plugin-agentmail";
import { ComposioProvider } from "@opensquad/plugin-composio";
import { DaytonaProvider } from "@opensquad/plugin-daytona";
import { LocalStorageProvider } from "@opensquad/plugin-local-storage";
import { Mem0Provider } from "@opensquad/plugin-mem0";
import { OpenRouterProvider } from "@opensquad/plugin-openrouter";
import { SupabaseStorageProvider } from "@opensquad/plugin-supabase-storage";
import { TriggerProvider } from "@opensquad/plugin-trigger";
import { VapiProvider } from "@opensquad/plugin-vapi";
import type { Env } from "../config/env.js";

/**
 * The one place that decides which plugin backs each capability.
 * Swapping a provider means changing one line here. SPEC sections 3 and 5.
 */
export function buildCapabilities(env: Env): Capabilities {
  const storage =
    env.STORAGE_PROVIDER === "supabase"
      ? new SupabaseStorageProvider({
          url: env.SUPABASE_URL ?? "",
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          bucket: env.SUPABASE_STORAGE_BUCKET,
        })
      : new LocalStorageProvider({
          rootDir: env.LOCAL_STORAGE_DIR,
          publicBaseUrl: `http://localhost:${env.PORT}`,
        });

  return {
    model: new OpenRouterProvider(),
    sandbox: new DaytonaProvider({ apiKey: env.DAYTONA_API_KEY ?? "" }),
    memory: new Mem0Provider({ apiKey: env.MEM0_API_KEY ?? "" }),
    email: new AgentMailProvider({ apiKey: env.AGENTMAIL_API_KEY ?? "" }),
    phone: new VapiProvider({ apiKey: env.VAPI_API_KEY ?? "" }),
    tools: new ComposioProvider({ apiKey: env.COMPOSIO_API_KEY ?? "" }),
    scheduler: new TriggerProvider({ secretKey: env.TRIGGER_SECRET_KEY ?? "" }),
    storage,
  };
}
