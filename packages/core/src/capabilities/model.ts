import type { MessageRole } from "../primitives/index.js";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** Model capability. Default provider: OpenRouter. BYOK credentials are injected by the caller. */
export interface ModelProvider {
  readonly name: string;
  complete(
    options: ChatCompletionOptions,
    credentials: { apiKey: string },
  ): Promise<ChatCompletionResult>;
}
