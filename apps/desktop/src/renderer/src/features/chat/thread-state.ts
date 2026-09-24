import type {
  ConversationMessage,
  ConversationParticipant,
  ConversationRun,
  ConversationRunStatus,
  ConversationSnapshot,
  ConversationSummary,
  EnvironmentStatus,
  MessageContentPart,
} from "@opensquad/core";

export interface ThreadState {
  conversation: ConversationSummary | null;
  participants: ConversationParticipant[];
  messages: ConversationMessage[];
  activeRun: ConversationRun | null;
  lastRun: ConversationRun | null;
  nextMessageCursor: string | null;
  environment: ConversationSnapshot["environment"];
}

export const emptyThread: ThreadState = {
  conversation: null,
  participants: [],
  messages: [],
  activeRun: null,
  lastRun: null,
  nextMessageCursor: null,
  environment: null,
};

export type ThreadEvent = { type: string; payload: unknown };

const TERMINAL: ReadonlySet<ConversationRunStatus> = new Set(["succeeded", "failed", "cancelled"]);
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
const MESSAGE_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "incomplete"]);
const ENVIRONMENT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "ready",
  "connected",
  "disconnected",
  "reset",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSequence(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isEnvironmentStatus(value: unknown): value is EnvironmentStatus {
  return typeof value === "string" && ENVIRONMENT_STATUSES.has(value);
}

function isEnvironment(value: unknown): value is ConversationSnapshot["environment"] {
  if (value === null) return true;
  return (
    isRecord(value) &&
    (value.type === "hosted" || value.type === "none") &&
    (value.status === null || isEnvironmentStatus(value.status))
  );
}

function isContentPart(value: unknown): value is MessageContentPart {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value.index) || typeof value.completed !== "boolean") return false;
  return (
    (value.type === "text" && typeof value.text === "string") ||
    (value.type === "image" && typeof value.url === "string") ||
    (value.type === "command" &&
      typeof value.command === "string" &&
      (value.cwd === null || typeof value.cwd === "string") &&
      (value.exitCode === null ||
        (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
      (value.durationMs === null ||
        (typeof value.durationMs === "number" &&
          Number.isFinite(value.durationMs) &&
          value.durationMs >= 0)) &&
      typeof value.output === "string" &&
      typeof value.outputTruncated === "boolean")
  );
}

function isMessage(value: unknown): value is ConversationMessage {
  if (!isRecord(value)) return false;
  for (const key of ["id", "conversationId", "participantId", "runId", "createdAt"]) {
    if (typeof value[key] !== "string") return false;
  }
  return (
    isSequence(value.sequence) &&
    (value.role === "user" || value.role === "assistant") &&
    Array.isArray(value.content) &&
    value.content.every(isContentPart) &&
    MESSAGE_STATUSES.has(value.status as string) &&
    (value.phase === null || value.phase === "commentary" || value.phase === "final")
  );
}

function isRun(value: unknown): value is ConversationRun {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.clientRequestId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.active !== "boolean" ||
    typeof value.cancelRequested !== "boolean" ||
    !RUN_STATUSES.has(value.status as string)
  ) {
    return false;
  }
  if (
    value.observation !== "connected" &&
    value.observation !== "disconnected" &&
    value.observation !== "reconciliation_required"
  ) {
    return false;
  }
  if (value.error !== null) {
    if (
      !isRecord(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string"
    ) {
      return false;
    }
  }
  return value.usage === null || isRecord(value.usage);
}

function isParticipant(value: unknown): value is ConversationParticipant {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.refId === "string" &&
    typeof value.name === "string" &&
    (value.kind === "user" || value.kind === "agent") &&
    (value.deletedAt === null || typeof value.deletedAt === "string")
  );
}

function isSummary(value: unknown): value is ConversationSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    (value.title === null || typeof value.title === "string")
  );
}

function isSnapshot(value: unknown): value is ConversationSnapshot {
  return (
    isRecord(value) &&
    isSummary(value.conversation) &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    Array.isArray(value.latestMessages) &&
    value.latestMessages.every(isMessage) &&
    (value.activeRun === null || isRun(value.activeRun)) &&
    (value.nextMessageCursor === null || typeof value.nextMessageCursor === "string") &&
    isEnvironment(value.environment)
  );
}

function sortMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return [...messages].sort((a, b) => {
    const first = BigInt(a.sequence);
    const second = BigInt(b.sequence);
    return first < second ? -1 : first > second ? 1 : 0;
  });
}

function upsertMessage(
  messages: ConversationMessage[],
  message: ConversationMessage,
  replace: (existing: ConversationMessage) => boolean,
): ConversationMessage[] {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index === -1) return sortMessages([...messages, message]);
  const existing = messages[index];
  if (!existing || !replace(existing)) return messages;
  const next = [...messages];
  next[index] = message;
  return next;
}

function editContentPart(
  state: ThreadState,
  messageId: unknown,
  contentIndex: unknown,
  text: unknown,
  complete: boolean,
): ThreadState {
  if (
    typeof messageId !== "string" ||
    !Number.isInteger(contentIndex) ||
    typeof text !== "string"
  ) {
    return state;
  }
  const message = state.messages.find((entry) => entry.id === messageId);
  if (message?.status !== "running") return state;
  const partIndex = message.content.findIndex((part) => part.index === contentIndex);
  const part = partIndex === -1 ? undefined : message.content[partIndex];
  if (part?.completed) return state;
  let content: MessageContentPart[];
  if (!part) {
    content = [
      ...message.content,
      { index: contentIndex as number, type: "text", text, completed: complete },
    ];
    content.sort((a, b) => a.index - b.index);
  } else if (part.type !== "text") {
    return state;
  } else {
    content = [...message.content];
    content[partIndex] = complete
      ? { ...part, text, completed: true }
      : { ...part, text: part.text + text };
  }
  const nextMessage: ConversationMessage = { ...message, content };
  return {
    ...state,
    messages: state.messages.map((entry) => (entry.id === message.id ? nextMessage : entry)),
  };
}

function reduceRun(state: ThreadState, run: ConversationRun): ThreadState {
  if (run.active) {
    const current = state.activeRun;
    if (current?.id === run.id && TERMINAL.has(current.status) && !TERMINAL.has(run.status)) {
      return state;
    }
    return { ...state, activeRun: run };
  }
  if (state.activeRun?.id === run.id) {
    return { ...state, activeRun: null, lastRun: run };
  }
  if (state.activeRun === null) {
    const last = state.lastRun;
    if (!last || last.id === run.id || run.createdAt >= last.createdAt) {
      return { ...state, activeRun: null, lastRun: run };
    }
  }
  return state;
}

export function applyEvent(state: ThreadState, event: ThreadEvent): ThreadState {
  if (!isRecord(event)) return state;
  const payload = event.payload;
  switch (event.type) {
    case "conversation.snapshot": {
      if (!isSnapshot(payload)) return state;
      return {
        ...state,
        conversation: payload.conversation,
        participants: payload.participants,
        messages: sortMessages(payload.latestMessages),
        activeRun: payload.activeRun,
        lastRun: payload.activeRun ? null : state.lastRun,
        nextMessageCursor: payload.nextMessageCursor,
        environment: payload.environment,
      };
    }
    case "message.created": {
      if (!isRecord(payload) || !isMessage(payload.message)) return state;
      return {
        ...state,
        messages: upsertMessage(state.messages, payload.message, (m) => m.status === "running"),
      };
    }
    case "message.delta": {
      if (!isRecord(payload)) return state;
      return editContentPart(state, payload.messageId, payload.contentIndex, payload.text, false);
    }
    case "message.text.completed": {
      if (!isRecord(payload)) return state;
      return editContentPart(state, payload.messageId, payload.contentIndex, payload.text, true);
    }
    case "message.completed": {
      if (!isRecord(payload) || !isMessage(payload.message)) return state;
      return {
        ...state,
        messages: upsertMessage(state.messages, payload.message, () => true),
      };
    }
    case "environment.updated": {
      if (!isRecord(payload) || !isEnvironmentStatus(payload.status)) return state;
      const environment = state.environment ?? { type: "hosted" as const, status: null };
      return { ...state, environment: { ...environment, status: payload.status } };
    }
    case "run.updated": {
      if (!isRecord(payload) || !isRun(payload.run)) return state;
      return reduceRun(state, payload.run);
    }
    case "participant.updated": {
      if (!isRecord(payload) || !isParticipant(payload.participant)) return state;
      const participant = payload.participant;
      const index = state.participants.findIndex((entry) => entry.id === participant.id);
      const participants =
        index === -1
          ? [...state.participants, participant]
          : state.participants.map((entry) => (entry.id === participant.id ? participant : entry));
      return { ...state, participants };
    }
    default:
      return state;
  }
}

export function prependMessages(
  state: ThreadState,
  page: { items: ConversationMessage[]; nextCursor: string | null },
): ThreadState {
  const seen = new Set<string>();
  const merged = [...page.items, ...state.messages].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  return { ...state, messages: sortMessages(merged), nextMessageCursor: page.nextCursor };
}
