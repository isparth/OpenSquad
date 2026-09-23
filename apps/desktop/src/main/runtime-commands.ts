import { z } from "zod";
import type {
  RefreshMemoryCommand,
  RefreshMemoryResult,
  RunCommand,
  RunResult,
  SendMessageCommand,
  SendMessageResult,
} from "../shared/ipc.js";
import type { RuntimeCredentialVault } from "./runtime-credentials.js";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIVE_COMMANDS = 4;
const MAX_COMMANDS_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;

export const sendMessageCommandSchema = z.strictObject({
  conversationId: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0),
  clientRequestId: z.uuid(),
});

export const runCommandSchema = z.strictObject({ runId: z.uuid() });
export const refreshMemoryCommandSchema = z.strictObject({ agentId: z.uuid() });

const isoDateTime = z.iso.datetime();

const memoryUpdateSchema = z.strictObject({
  id: z.uuid(),
  agentId: z.uuid(),
  trigger: z.enum(["auto", "manual"]),
  status: z.enum(["running", "succeeded", "failed"]),
  changed: z
    .array(
      z.strictObject({
        name: z.enum(["profile", "preferences", "notes"]),
        fromVersion: z.number().int().min(0),
        toVersion: z.number().int().min(1),
      }),
    )
    .max(3),
  errorCode: z.string().max(64).nullable(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});

const refreshMemoryResultSchema = z.strictObject({ update: memoryUpdateSchema.nullable() });

const runSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  agentParticipantId: z.uuid(),
  clientRequestId: z.uuid(),
  status: z.enum(["pending", "running", "waiting", "succeeded", "failed", "cancelled"]),
  observation: z.enum(["connected", "disconnected", "reconciliation_required"]),
  active: z.boolean(),
  cancelRequested: z.boolean(),
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  deadlineAt: isoDateTime,
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
  error: z
    .strictObject({ code: z.string().min(1).max(64), message: z.string().min(1).max(512) })
    .nullable(),
});

const contentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    index: z.number().int().min(0).max(99),
    completed: z.boolean(),
    type: z.literal("text"),
    text: z.string().max(100_000),
  }),
  z.strictObject({
    index: z.number().int().min(0).max(99),
    completed: z.boolean(),
    type: z.literal("image"),
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      }),
  }),
]);

const messageSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  participantId: z.uuid(),
  runId: z.uuid(),
  sequence: z
    .string()
    .refine(
      (value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    ),
  role: z.enum(["user", "assistant"]),
  content: z.array(contentPartSchema).max(100),
  phase: z.enum(["commentary", "final"]).nullable(),
  status: z.enum(["running", "completed", "incomplete"]),
  createdAt: isoDateTime,
});

const sendMessageResultSchema = z.strictObject({ message: messageSchema, run: runSchema });
const runResultSchema = z.strictObject({ run: runSchema });

class CommandError extends Error {}

function statusError(status: number): string {
  switch (status) {
    case 400:
      return "request rejected";
    case 401:
    case 403:
      return "authentication required";
    case 404:
      return "resource not found";
    case 409:
      return "request conflict";
    case 429:
      return "rate limited";
    default:
      return "service unavailable";
  }
}

export interface RuntimeCommands {
  sendMessage(command: SendMessageCommand, signal?: AbortSignal): Promise<SendMessageResult>;
  cancelRun(command: RunCommand, signal?: AbortSignal): Promise<RunResult>;
  reconcileRun(command: RunCommand, signal?: AbortSignal): Promise<RunResult>;
  refreshMemory(command: RefreshMemoryCommand, signal?: AbortSignal): Promise<RefreshMemoryResult>;
  abortAll(): void;
}

export interface RuntimeCommandsOptions {
  vault: RuntimeCredentialVault;
  fetch: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function createRuntimeCommands(options: RuntimeCommandsOptions): RuntimeCommands {
  const { vault } = options;
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
      throw new CommandError("runtime command rate limit exceeded");
    }
    if (active >= MAX_ACTIVE_COMMANDS) {
      throw new CommandError("too many active runtime commands");
    }
    admittedAt.push(now());
    active += 1;
  }

  async function readLimitedBody(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new CommandError("response too large");
    }
    if (!response.body) throw new CommandError("request failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new CommandError("response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new CommandError("invalid response");
    }
  }

  async function request<S>(
    path: string,
    body: unknown,
    schema: z.ZodType<S>,
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
      if (!credential.ok) throw new CommandError("runtime credential unavailable");
      const origin = vault.origin;
      if (origin === null) throw new CommandError("runtime credential unavailable");
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-OpenSquad-Runtime-Key": credential.key,
          },
          body: JSON.stringify(body),
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
        throw new CommandError(statusError(response.status));
      }
      const mediaType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        await response.body?.cancel().catch(() => {});
        throw new CommandError("invalid response");
      }
      const parsed = await readLimitedBody(response);
      const result = schema.safeParse(parsed);
      if (!result.success) throw new CommandError("invalid response");
      return result.data;
    } finally {
      controllers.delete(controller);
      active -= 1;
    }
  }

  return {
    sendMessage: (command, signal) => {
      const parsed = sendMessageCommandSchema.safeParse(command);
      if (!parsed.success) return Promise.reject(new CommandError("invalid request"));
      return request(
        `/conversations/${parsed.data.conversationId}/messages`,
        { text: parsed.data.text, clientRequestId: parsed.data.clientRequestId },
        sendMessageResultSchema,
        signal,
      );
    },
    cancelRun: (command, signal) => {
      const parsed = runCommandSchema.safeParse(command);
      if (!parsed.success) return Promise.reject(new CommandError("invalid request"));
      return request(`/runs/${parsed.data.runId}/cancel`, {}, runResultSchema, signal);
    },
    reconcileRun: (command, signal) => {
      const parsed = runCommandSchema.safeParse(command);
      if (!parsed.success) return Promise.reject(new CommandError("invalid request"));
      return request(`/runs/${parsed.data.runId}/reconcile`, {}, runResultSchema, signal);
    },
    refreshMemory: (command, signal) => {
      const parsed = refreshMemoryCommandSchema.safeParse(command);
      if (!parsed.success) return Promise.reject(new CommandError("invalid request"));
      return request(
        `/agents/${parsed.data.agentId}/memory/refresh`,
        {},
        refreshMemoryResultSchema,
        signal,
      );
    },
    abortAll: () => {
      for (const controller of controllers) controller.abort();
    },
  };
}

export const runtimeCommandLimits = {
  maxActive: MAX_ACTIVE_COMMANDS,
  perMinute: MAX_COMMANDS_PER_MINUTE,
  maxBodyBytes: MAX_BODY_BYTES,
  timeoutMs: REQUEST_TIMEOUT_MS,
};
