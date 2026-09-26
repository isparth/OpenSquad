import { z } from "zod";
import type {
  ListToolkitsCommand,
  ListToolkitsResult,
  RemoveToolConnectionCommand,
  StartToolConnectionCommand,
  StartToolConnectionResult,
  ToolConnectionsResult,
} from "../shared/ipc.js";
import { CommandError, readLimitedBody, statusError } from "./runtime-commands.js";
import type { RuntimeCredentialVault } from "./runtime-credentials.js";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIVE_COMMANDS = 4;
const MAX_COMMANDS_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;

const toolkitSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const connectionId = z.string().regex(/^ca_[A-Za-z0-9_-]{1,64}$/);

export const listToolkitsCommandSchema = z.strictObject({
  search: z.string().max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
export const startToolConnectionCommandSchema = z.strictObject({ toolkit: toolkitSlug });
export const removeToolConnectionCommandSchema = z.strictObject({ connectionId });

const toolkitsResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        slug: toolkitSlug,
        name: z.string().max(200),
        description: z.string().max(500),
        toolsCount: z.number().int().nonnegative(),
      }),
    )
    .max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
});

const connectionsResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: connectionId,
        toolkit: toolkitSlug,
        status: z.enum(["active", "pending", "attention"]),
        createdAt: z.string().max(64),
      }),
    )
    .max(500),
});

const startResultSchema = z.strictObject({ connectionId, redirectUrl: z.string().max(2048) });

/** Only Composio's hosted Connect Link may be opened in the system browser. */
export function isConnectLink(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "connect.composio.dev" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export interface ToolsCommands {
  listToolkits(command: ListToolkitsCommand, signal?: AbortSignal): Promise<ListToolkitsResult>;
  listConnections(signal?: AbortSignal): Promise<ToolConnectionsResult>;
  startConnection(
    command: StartToolConnectionCommand,
    signal?: AbortSignal,
  ): Promise<StartToolConnectionResult>;
  removeConnection(command: RemoveToolConnectionCommand, signal?: AbortSignal): Promise<void>;
  abortAll(): void;
}

export interface ToolsCommandsOptions {
  vault: RuntimeCredentialVault;
  fetch: typeof fetch;
  openExternal(url: string): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export function createToolsCommands(options: ToolsCommandsOptions): ToolsCommands {
  const { vault, openExternal } = options;
  const fetchImpl = options.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let active = 0;
  const admittedAt: number[] = [];
  const controllers = new Set<AbortController>();

  function admit(): void {
    const cutoff = now() - RATE_WINDOW_MS;
    while (admittedAt.length > 0 && (admittedAt[0] ?? 0) <= cutoff) admittedAt.shift();
    if (admittedAt.length >= MAX_COMMANDS_PER_MINUTE) {
      throw new CommandError("tools command rate limit exceeded");
    }
    if (active >= MAX_ACTIVE_COMMANDS) throw new CommandError("too many active tools commands");
    admittedAt.push(now());
    active += 1;
  }

  async function request<S>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    schema: z.ZodType<S> | null,
    callerSignal: AbortSignal | undefined,
  ): Promise<S> {
    admit();
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout, controller.signal];
    if (callerSignal) signals.push(callerSignal);
    const signal = AbortSignal.any(signals);
    controllers.add(controller);
    try {
      const credential = await vault.readKey();
      if (!credential.ok) throw new CommandError("tools credential unavailable");
      const origin = vault.origin;
      if (origin === null) throw new CommandError("tools credential unavailable");
      const headers: Record<string, string> = { "X-OpenSquad-Tools-Key": credential.key };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal,
        });
      } catch {
        if (timeout.aborted) throw new CommandError("request timed out");
        if (signal.aborted) throw new CommandError("request aborted");
        throw new CommandError("request failed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new CommandError(
          response.status === 422 ? "tools key rejected" : statusError(response.status),
        );
      }
      if (schema === null) {
        await response.body?.cancel().catch(() => {});
        if (response.status !== 204) throw new CommandError("invalid response");
        return undefined as S;
      }
      const mediaType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        await response.body?.cancel().catch(() => {});
        throw new CommandError("invalid response");
      }
      const result = schema.safeParse(await readLimitedBody(response, MAX_BODY_BYTES));
      if (!result.success) throw new CommandError("invalid response");
      return result.data;
    } finally {
      controllers.delete(controller);
      active -= 1;
    }
  }

  return {
    listToolkits: (command, signal) => {
      const parsed = listToolkitsCommandSchema.safeParse(command);
      if (!parsed.success) return Promise.reject(new CommandError("invalid request"));
      const query = new URLSearchParams();
      if (parsed.data.search?.trim()) query.set("search", parsed.data.search.trim());
      if (parsed.data.cursor) query.set("cursor", parsed.data.cursor);
      const suffix = query.size > 0 ? `?${query}` : "";
      return request("GET", `/tools/toolkits${suffix}`, undefined, toolkitsResultSchema, signal);
    },
    listConnections: (signal) =>
      request("GET", "/tools/connections", undefined, connectionsResultSchema, signal),
    startConnection: async (command, signal) => {
      const parsed = startToolConnectionCommandSchema.safeParse(command);
      if (!parsed.success) throw new CommandError("invalid request");
      const result = await request(
        "POST",
        "/tools/connections",
        { toolkit: parsed.data.toolkit },
        startResultSchema,
        signal,
      );
      if (!isConnectLink(result.redirectUrl)) throw new CommandError("invalid response");
      try {
        await openExternal(result.redirectUrl);
      } catch {
        throw new CommandError("unable to open browser");
      }
      return { connectionId: result.connectionId };
    },
    removeConnection: (command, signal) => {
      const parsed = removeToolConnectionCommandSchema.safeParse(command);
      if (!parsed.success) return Promise.reject(new CommandError("invalid request"));
      return request(
        "DELETE",
        `/tools/connections/${parsed.data.connectionId}`,
        undefined,
        null,
        signal,
      );
    },
    abortAll: () => {
      for (const controller of controllers) controller.abort();
    },
  };
}
