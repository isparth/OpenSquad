import type { ChatCompletionOptions, ChatCompletionResult, ModelProvider } from "@opensquad/core";

/** OpenRouter model provider. BYOK: the api key is passed per call, never stored here. */
export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";

  complete(
    _options: ChatCompletionOptions,
    _credentials: { apiKey: string },
  ): Promise<ChatCompletionResult> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
