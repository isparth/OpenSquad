import type { EmailProvider } from "./email.js";
import type { PhoneProvider } from "./phone.js";
import type { AgentRuntimeProvider } from "./runtime.js";
import type { SchedulerProvider } from "./scheduler.js";
import type { StorageProvider } from "./storage.js";
import type { ToolsProvider } from "./tools.js";

export * from "./email.js";
export * from "./model.js";
export * from "./phone.js";
export * from "./runtime.js";
export * from "./sandbox.js";
export * from "./scheduler.js";
export * from "./storage.js";
export * from "./tools.js";

/**
 * Everything the core runtime needs from the outside world.
 * The core only ever depends on this shape, never on a provider.
 * See llm_docs/SPEC.md section 2.
 */
export interface Capabilities {
  runtime: AgentRuntimeProvider;
  email: EmailProvider;
  phone: PhoneProvider;
  tools: ToolsProvider;
  scheduler: SchedulerProvider;
  storage: StorageProvider;
}

export type CapabilityName = keyof Capabilities;
