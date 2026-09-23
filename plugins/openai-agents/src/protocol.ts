import type { RuntimeEvent, RuntimeMessage, RuntimeSession, RuntimeTurn } from "@opensquad/core";
import { z } from "zod";

const id = z.string().min(1);
const errorSchema = z.object({ code: z.string(), message: z.string() });
const errorMessages = {
  context_length_exceeded: "The model context limit was exceeded",
  session_budget_exceeded: "The session usage budget was exceeded",
  usage_limit_exceeded: "The account usage limit was exceeded",
  credit_balance_exhausted: "The account has no API credits remaining",
  rate_limit_exceeded: "The request rate limit was exceeded",
  server_overloaded: "The model service is temporarily overloaded",
  cyber_policy: "The request was rejected by a safety policy",
  connection_failed: "The model service connection failed",
  server_error: "The model service encountered an error",
  authentication_error: "The API credentials are invalid or lack access",
  invalid_request: "The request input or configuration is invalid",
  resource_not_found: "The requested model or resource is unavailable",
  sandbox_error: "Environment failed",
  executor_version_incompatible: "The environment executor must be upgraded",
  active_turn_not_steerable: "The active turn cannot accept additional input",
  request_timeout: "The model service request timed out",
  internal_error: "The runtime encountered an internal error",
} as const;

function normalizeError(error: z.infer<typeof errorSchema>): NonNullable<RuntimeTurn["error"]> {
  if (Object.hasOwn(errorMessages, error.code)) {
    const code = error.code as keyof typeof errorMessages;
    return { code, message: errorMessages[code] };
  }
  return { code: null, message: "Agent runtime failed" };
}
const sessionStatusSchema = z.enum(["idle", "in_progress", "requires_action", "failed"]);
const sessionStatuses = {
  idle: "idle",
  in_progress: "running",
  requires_action: "waiting",
  failed: "failed",
} as const;
const turnStatuses = {
  queued: "pending",
  in_progress: "running",
  waiting: "waiting",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;
const sessionSchema = z.object({
  id,
  agent: z.object({ model: id }),
  status: sessionStatusSchema,
  environment: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({ id, type: z.literal("openai_hosted") }),
  ]),
});
const usageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() });
const turnSchema = z.object({
  id,
  subagent_id: id.nullable(),
  status: z.enum(["queued", "in_progress", "waiting", "completed", "failed", "cancelled"]),
  error: errorSchema.nullable(),
  usage: usageSchema.nullable(),
});
const messageSchema = z.object({
  id: id.nullable(),
  turn_id: id,
  role: z.enum(["user", "assistant"]),
  phase: z.enum(["commentary", "final_answer"]).nullable(),
  status: z.enum(["in_progress", "completed", "incomplete"]),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() }),
      z.object({ type: z.literal("input_image"), image_url: z.string() }),
    ]),
  ),
});
const commandExecutionSchema = z.object({
  type: z.literal("command_execution"),
  id,
  turn_id: id,
  command: z.string(),
  cwd: z.string().nullable(),
  status: z.string(),
  output: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().nonnegative().nullable(),
});
const environmentStatusSchema = z.enum(["pending", "ready", "connected", "disconnected", "reset"]);
const eventSchema = z.looseObject({ type: z.string() });
const scopedEventSchema = z.object({
  event_id: id,
  session_id: id,
  turn_id: id.nullish(),
});

function eventBase(input: unknown) {
  const event = parse(scopedEventSchema, input);
  return {
    externalId: event.event_id,
    sessionExternalId: event.session_id,
    turnExternalId: event.turn_id ?? null,
  };
}
const textSchema = z.object({
  item_id: id,
  content_index: z.number().int().nonnegative(),
  delta: z.string().optional(),
  text: z.string().optional(),
});
export const pageSchema = z.object({
  data: z.array(z.unknown()),
  has_more: z.boolean(),
  last_id: id.nullable(),
});

export const COMMAND_OUTPUT_LIMIT = 16_384;
const COMMAND_OUTPUT_TRUNCATION_MARKER = "\n… output truncated …\n";

function capCommandOutput(output: string): { output: string; outputTruncated: boolean } {
  if (output.length <= COMMAND_OUTPUT_LIMIT) return { output, outputTruncated: false };
  return {
    output: `${output.slice(0, 8_000)}${COMMAND_OUTPUT_TRUNCATION_MARKER}${output.slice(-8_000)}`,
    outputTruncated: true,
  };
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error("openai-agents: Invalid Agents API response");
  return result.data;
}

export function normalizeSession(input: unknown): RuntimeSession {
  const session = parse(sessionSchema, input);
  return {
    provider: "openai-agents",
    externalId: session.id,
    model: session.agent.model,
    status: sessionStatuses[session.status],
    environmentExternalId: session.environment.type === "none" ? null : session.environment.id,
  };
}

function normalizeUsage(usage: z.infer<typeof usageSchema>): NonNullable<RuntimeTurn["usage"]> {
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

export function normalizeTurn(input: unknown): RuntimeTurn {
  const turn = parse(turnSchema, input);
  return {
    externalId: turn.id,
    subagentExternalId: turn.subagent_id,
    status: turnStatuses[turn.status],
    error: turn.error ? normalizeError(turn.error) : null,
    usage: turn.usage ? normalizeUsage(turn.usage) : null,
  };
}

export function normalizeMessage(input: unknown): RuntimeMessage | null {
  const item = parse(z.looseObject({ type: z.string() }), input);
  if (item.type === "command_execution") {
    const command = parse(commandExecutionSchema, input);
    const cappedOutput = capCommandOutput(command.output ?? "");
    return {
      externalId: command.id,
      turnExternalId: command.turn_id,
      role: "assistant",
      phase: null,
      status:
        command.status === "in_progress"
          ? "running"
          : command.status === "completed"
            ? "completed"
            : "incomplete",
      content: [
        {
          type: "command",
          command: command.command,
          cwd: command.cwd,
          exitCode: command.exit_code,
          durationMs: command.duration_ms,
          ...cappedOutput,
        },
      ],
    };
  }
  if (item.type !== "message") return null;
  const message = parse(messageSchema, input);
  return {
    externalId: message.id,
    turnExternalId: message.turn_id,
    role: message.role,
    phase: message.phase === "final_answer" ? "final" : message.phase,
    status: message.status === "in_progress" ? "running" : message.status,
    content: message.content.map((part) =>
      part.type === "input_image"
        ? { type: "image", url: part.image_url }
        : { type: "text", text: part.text },
    ),
  };
}

export function normalizeEvent(input: unknown): RuntimeEvent | null {
  const event = parse(eventSchema, input);
  switch (event.type) {
    case "agent.session.created":
    case "agent.session.idle":
    case "agent.session.in_progress":
    case "agent.session.requires_action":
    case "agent.session.failed": {
      const lifecycle = parse(
        z.object({ event_id: id, session: z.object({ id, status: sessionStatusSchema }) }),
        event,
      );
      return {
        externalId: lifecycle.event_id,
        sessionExternalId: lifecycle.session.id,
        turnExternalId: null,
        type: "session.status",
        status: sessionStatuses[lifecycle.session.status],
      };
    }
    case "agent.session.turn.created":
    case "agent.session.turn.in_progress":
    case "agent.session.turn.completed":
    case "agent.session.turn.failed":
    case "agent.session.turn.cancelled": {
      const turn = normalizeTurn(event.turn);
      const usage = parse(z.object({ usage: usageSchema.nullish() }), event).usage;
      if (usage) turn.usage = normalizeUsage(usage);
      return { ...eventBase(event), turnExternalId: turn.externalId, type: "turn.status", turn };
    }
    case "agent.session.turn.output_text.delta":
    case "agent.session.turn.output_text.done": {
      const part = parse(textSchema, event);
      const delta = event.type === "agent.session.turn.output_text.delta";
      return {
        ...eventBase(event),
        type: delta ? "message.delta" : "message.text.completed",
        itemExternalId: part.item_id,
        contentIndex: part.content_index,
        text: parse(z.string(), delta ? part.delta : part.text),
      };
    }
    case "agent.session.turn.item.added": {
      const { item } = parse(z.object({ item: z.looseObject({ type: z.string() }) }), event);
      if (item.type !== "command_execution") return null;
      const message = normalizeMessage(item);
      return message ? { ...eventBase(event), type: "message.completed", message } : null;
    }
    case "agent.session.turn.item.done": {
      const message = normalizeMessage(event.item);
      return message ? { ...eventBase(event), type: "message.completed", message } : null;
    }
    case "agent.session.environment.pending":
    case "agent.session.environment.ready":
    case "agent.session.environment.connected":
    case "agent.session.environment.disconnected":
    case "agent.session.environment.reset": {
      const environment = parse(z.object({ status: environmentStatusSchema }), event.environment);
      return { ...eventBase(event), type: "environment.status", status: environment.status };
    }
    case "agent.session.environment.failed": {
      const environment = parse(z.object({ error: errorSchema.nullable() }), event.environment);
      return {
        ...eventBase(event),
        type: "runtime.error",
        ...(environment.error
          ? normalizeError(environment.error)
          : { code: null, message: "Environment failed" }),
      };
    }
    default:
      return null;
  }
}

export function isTerminal(event: RuntimeEvent): boolean {
  return (
    event.type === "runtime.error" ||
    (event.type === "session.status" && event.status === "failed") ||
    (event.type === "turn.status" &&
      event.turn.subagentExternalId === null &&
      ["succeeded", "failed", "cancelled"].includes(event.turn.status))
  );
}
