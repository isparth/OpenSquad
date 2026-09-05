import type { ToolDefinition, ToolsProvider } from "@opensquad/core";

/** Composio tools provider. The only place the Composio SDK may be imported. */
export class ComposioProvider implements ToolsProvider {
  readonly name = "composio";

  constructor(protected readonly options: { apiKey: string }) {}

  list(_agentId: string): Promise<ToolDefinition[]> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  execute(_agentId: string, _toolName: string, _input: unknown): Promise<unknown> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
