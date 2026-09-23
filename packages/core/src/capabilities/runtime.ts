export interface RuntimeCredentials {
  apiKey: string;
  mcp?: Record<string, { authorization?: string; headers?: Record<string, string> }>;
}

export interface RuntimeMcpServer {
  name: string;
  url: string;
  allowedTools: string[];
}

export type RuntimeEnvironment = "hosted" | "none";

export interface CreateRuntimeSessionOptions {
  instructions: string;
  model?: string;
  /** Defaults to "hosted". "none" runs without an execution environment; creation then submits `input` as the first turn. */
  environment?: RuntimeEnvironment;
  /** Initial user input submitted at creation. Required (non-blank) with environment "none", rejected otherwise. */
  input?: string;
  mcpServers?: RuntimeMcpServer[];
  maxConcurrentSubagents?: number;
}

export interface RuntimeSessionRef {
  provider: string;
  externalId: string;
}

export type RuntimeSessionStatus = "idle" | "running" | "waiting" | "failed";
export type RuntimeTurnStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeSession extends RuntimeSessionRef {
  model: string;
  status: RuntimeSessionStatus;
  environmentExternalId: string | null;
}

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RuntimeTurn {
  externalId: string;
  subagentExternalId: string | null;
  status: RuntimeTurnStatus;
  usage: RuntimeUsage | null;
  error: { code: string | null; message: string } | null;
}

export interface RuntimeMessage {
  externalId: string | null;
  turnExternalId: string;
  role: "user" | "assistant";
  status: "running" | "completed" | "incomplete";
  phase: "commentary" | "final" | null;
  content: Array<{ type: "text"; text: string } | { type: "image"; url: string }>;
}

export type RuntimeEvent = {
  externalId: string;
  sessionExternalId: string;
  turnExternalId: string | null;
} & (
  | { type: "session.status"; status: RuntimeSessionStatus }
  | { type: "turn.status"; turn: RuntimeTurn }
  | {
      type: "message.delta" | "message.text.completed";
      itemExternalId: string;
      contentIndex: number;
      text: string;
    }
  | { type: "message.completed"; message: RuntimeMessage }
  | { type: "runtime.error"; code: string | null; message: string }
);

export interface RuntimeEventStream extends AsyncIterable<RuntimeEvent> {
  close(): void;
}

export interface RuntimeRequestOptions {
  signal?: AbortSignal;
}

export interface AgentRuntimeProvider {
  readonly name: string;
  readonly features: {
    hostedEnvironment: boolean;
    environmentless: boolean;
    mcp: boolean;
    subagents: boolean;
    steering: boolean;
  };
  createSession(
    options: CreateRuntimeSessionOptions,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): Promise<RuntimeSession>;
  retrieveSession(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): Promise<RuntimeSession>;
  sendInput(
    session: RuntimeSessionRef,
    text: string,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): Promise<void>;
  events(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): Promise<RuntimeEventStream>;
  listMessages(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): AsyncIterable<RuntimeMessage>;
  listTurns(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): AsyncIterable<RuntimeTurn>;
  cancel(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): Promise<void>;
  destroySession(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request?: RuntimeRequestOptions,
  ): Promise<void>;
}
