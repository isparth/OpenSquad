import type {
  AgentRuntimeProvider,
  CreateRuntimeSessionOptions,
  RuntimeCredentials,
  RuntimeEventStream,
  RuntimeMessage,
  RuntimeRequestOptions,
  RuntimeSession,
  RuntimeSessionRef,
  RuntimeTurn,
} from "@opensquad/core";
import OpenAI from "openai";
import type { Stream } from "openai/core/streaming";
import { z } from "zod";
import {
  isTerminal,
  normalizeEvent,
  normalizeMessage,
  normalizeSession,
  normalizeTurn,
  pageSchema,
  parse,
} from "./protocol.js";

const sessionOptionsSchema = z
  .object({
    instructions: z.string(),
    model: z.string().trim().min(1).optional(),
    environment: z.enum(["hosted", "none"]).optional(),
    input: z.string().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    maxConcurrentSubagents: z.number().int().min(1).max(16).optional(),
    mcpServers: z
      .array(
        z.object({
          name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          url: z.url().refine((value) => {
            const url = new URL(value);
            return url.protocol === "https:" && !url.username && !url.password && !url.hash;
          }, "MCP servers require HTTPS and credentials supplied separately"),
          allowedTools: z.array(z.string().min(1)).min(1),
        }),
      )
      .refine(
        (servers) => new Set(servers.map((server) => server.name)).size === servers.length,
        "MCP server names must be unique",
      )
      .optional(),
  })
  .superRefine((config, context) => {
    if (config.environment === "none" && !config.input?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["input"],
        message: "Input is required without an environment",
      });
    } else if (config.environment !== "none" && config.input !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["input"],
        message: "Input is only accepted without an environment",
      });
    }
  });

function requestError(error: unknown): Error {
  if (error instanceof OpenAI.APIError) {
    return new Error(
      `openai-agents: Request failed${error.status ? ` (HTTP ${error.status})` : ""}`,
    );
  }
  if (error instanceof Error && error.message.startsWith("openai-agents:")) return error;
  return new Error("openai-agents: Request failed or was aborted");
}

export class OpenAIAgentsProvider implements AgentRuntimeProvider {
  readonly name = "openai-agents";
  readonly features = Object.freeze({
    hostedEnvironment: true,
    environmentless: true,
    structuredOutput: true,
    mcp: true,
    subagents: true,
    steering: true,
  });
  readonly #defaultModel: string;
  readonly #fetch: typeof globalThis.fetch | undefined;

  constructor(options: { defaultModel?: string; fetch?: typeof globalThis.fetch } = {}) {
    this.#defaultModel = z
      .string()
      .trim()
      .min(1)
      .parse(options.defaultModel ?? "gpt-6-luna");
    this.#fetch = options.fetch;
  }

  #client(credentials: RuntimeCredentials, streaming = false): OpenAI {
    const apiKey = credentials.apiKey;
    if (!apiKey.trim()) throw new Error("openai-agents: An API key is required");
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "agents=v1",
      "Content-Type": "application/json",
      Accept: streaming ? "text/event-stream" : "application/json",
    };
    return new OpenAI({
      apiKey,
      baseURL: "https://api.openai.com/v1",
      organization: null,
      project: null,
      defaultHeaders: headers,
      maxRetries: 0,
      timeout: 60_000,
      logLevel: "off",
      fetch: (url, init) =>
        (this.#fetch ?? globalThis.fetch)(url, {
          ...init,
          headers: new Headers(headers),
          redirect: "error",
        }),
    });
  }

  async #request<T>(
    credentials: RuntimeCredentials,
    options: OpenAI.RequestOptions & { method: "get" | "post" | "delete"; path: string },
  ) {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("openai-agents: Request failed or was aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (signal.aborted) onAbort();
      return await Promise.race([
        aborted,
        Promise.resolve().then(() =>
          this.#client(credentials, options.stream)
            .request<T>({ ...options, signal })
            .withResponse(),
        ),
      ]);
    } catch (error) {
      controller.abort();
      throw requestError(error);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  #path(session: RuntimeSessionRef): string {
    if (session.provider !== this.name) throw new Error("openai-agents: Session provider mismatch");
    if (!/^[a-zA-Z0-9_-]+$/.test(session.externalId)) {
      throw new Error("openai-agents: Invalid Session ID");
    }
    return `/agents/sessions/${encodeURIComponent(session.externalId)}`;
  }

  async createSession(
    options: CreateRuntimeSessionOptions,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): Promise<RuntimeSession> {
    const config = sessionOptionsSchema.parse(options);
    const initialInput = config.environment === "none" ? config.input : undefined;
    const { data: response } = await this.#request<unknown>(credentials, {
      method: "post",
      path: "/agents/sessions",
      signal: request.signal,
      body: {
        agent: {
          model: config.model ?? this.#defaultModel,
          instructions: config.instructions,
          ...(config.outputSchema === undefined
            ? {}
            : { text: { format: { type: "json_schema", schema: config.outputSchema } } }),
          ...(config.maxConcurrentSubagents === undefined
            ? {}
            : {
                multi_agent: {
                  enabled: true,
                  max_concurrent_subagents: config.maxConcurrentSubagents,
                },
              }),
          ...(config.mcpServers === undefined
            ? {}
            : {
                tools: config.mcpServers.map((server) => ({
                  type: "mcp",
                  server_label: server.name,
                  transport: {
                    type: "http",
                    server_url: server.url,
                    authorization: credentials.mcp?.[server.name]?.authorization,
                    headers: credentials.mcp?.[server.name]?.headers,
                  },
                  allowed_tools: server.allowedTools,
                  required: true,
                })),
              }),
        },
        environment: config.environment === "none" ? { type: "none" } : { type: "openai_hosted" },
        ...(initialInput === undefined
          ? {}
          : {
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: initialInput }],
                },
              ],
            }),
      },
    });
    return normalizeSession(response);
  }

  async retrieveSession(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): Promise<RuntimeSession> {
    const path = this.#path(session);
    const { data: response } = await this.#request<unknown>(credentials, {
      method: "get",
      path,
      signal: request.signal,
    });
    const retrieved = normalizeSession(response);
    if (retrieved.externalId !== session.externalId) {
      throw new Error("openai-agents: Session ID mismatch");
    }
    return retrieved;
  }

  async sendInput(
    session: RuntimeSessionRef,
    text: string,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): Promise<void> {
    if (!text.trim()) throw new Error("openai-agents: Input must not be empty");
    const path = this.#path(session);
    await this.#request(credentials, {
      method: "post",
      path: `${path}/events`,
      signal: request.signal,
      body: {
        events: [
          {
            type: "agent.session.input.message",
            input: [{ role: "user", content: [{ type: "input_text", text }] }],
          },
        ],
      },
    });
  }

  async events(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): Promise<RuntimeEventStream> {
    const path = this.#path(session);
    const { data: stream, response } = await this.#request<Stream<unknown>>(credentials, {
      method: "get",
      path: `${path}/events`,
      signal: request.signal,
      query: { stream: true },
      stream: true,
    });
    if (
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "text/event-stream" ||
      !response.body
    ) {
      stream.controller.abort();
      void response.body?.cancel().catch(() => {});
      throw new Error("openai-agents: Invalid event stream response");
    }
    let closed = false;
    return {
      close: () => {
        closed = true;
        stream.controller.abort();
      },
      async *[Symbol.asyncIterator]() {
        try {
          for await (const input of stream) {
            const event = normalizeEvent(input);
            if (!event) continue;
            if (event.sessionExternalId !== session.externalId) {
              throw new Error("openai-agents: Event session mismatch");
            }
            yield event;
            if (isTerminal(event)) return;
          }
          if (!closed && !request.signal?.aborted) {
            throw new Error(
              "openai-agents: Stream closed before a root turn ended; retrieve saved messages and turns",
            );
          }
        } catch (error) {
          throw requestError(error);
        } finally {
          stream.controller.abort();
        }
      },
    };
  }

  async *#pages(
    session: RuntimeSessionRef,
    resource: "items" | "turns",
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions,
  ): AsyncIterable<unknown> {
    const path = this.#path(session);
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      const { data: response } = await this.#request<unknown>(credentials, {
        method: "get",
        path: `${path}/${resource}`,
        signal: request.signal,
        query: { order: "asc", limit: 100, ...(after ? { after } : {}) },
      });
      const page = parse(pageSchema, response);
      for (const item of page.data) yield item;
      if (!page.has_more) return;
      if (!page.last_id || cursors.has(page.last_id)) {
        throw new Error("openai-agents: Invalid pagination cursor");
      }
      after = page.last_id;
      cursors.add(after);
    } while (after);
  }

  async *listMessages(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): AsyncIterable<RuntimeMessage> {
    for await (const item of this.#pages(session, "items", credentials, request)) {
      const message = normalizeMessage(item);
      if (message) yield message;
    }
  }

  async *listTurns(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): AsyncIterable<RuntimeTurn> {
    for await (const turn of this.#pages(session, "turns", credentials, request))
      yield normalizeTurn(turn);
  }

  async cancel(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): Promise<void> {
    const path = this.#path(session);
    await this.#request(credentials, {
      method: "post",
      path: `${path}/events`,
      signal: request.signal,
      body: { events: [{ type: "agent.session.input.cancel" }] },
    });
  }

  async destroySession(
    session: RuntimeSessionRef,
    credentials: RuntimeCredentials,
    request: RuntimeRequestOptions = {},
  ): Promise<void> {
    const path = this.#path(session);
    await this.#request(credentials, {
      method: "delete",
      path,
      signal: request.signal,
    });
  }
}
