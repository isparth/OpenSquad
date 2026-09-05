export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input */
  inputSchema: Record<string, unknown>;
}

/** Tools capability. Default provider: Composio (and MCP). */
export interface ToolsProvider {
  readonly name: string;
  list(agentId: string): Promise<ToolDefinition[]>;
  execute(agentId: string, toolName: string, input: unknown): Promise<unknown>;
}
