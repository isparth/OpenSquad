import { type ToolsCredentials, ToolsError, type ToolsProvider } from "@opensquad/core";

export class ToolsHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const providerErrors: Record<ToolsError["code"], [number, string, string?]> = {
  unauthorized: [422, "The tools provider rejected the key", "tools_key_rejected"],
  not_found: [404, "Connection not found"],
  conflict: [409, "This app is already connected"],
  rate_limited: [429, "The tools provider is rate limiting requests"],
  invalid_response: [502, "The tools provider returned an invalid response"],
  unavailable: [502, "The tools provider is unavailable"],
  policy_mismatch: [502, "The tools provider did not apply the requested policy"],
};

function mapError(error: unknown): never {
  if (error instanceof ToolsError) {
    const [statusCode, message, code] = providerErrors[error.code] ?? [502, "Tools request failed"];
    throw new ToolsHttpError(statusCode, message, code);
  }
  throw error;
}

/** Thin, owner-scoped calls into the tools capability. The key is used in memory only. */
export function toolsService(tools: ToolsProvider) {
  return {
    listToolkits: (
      credentials: ToolsCredentials,
      options: { search?: string; cursor?: string },
      signal: AbortSignal,
    ) => tools.listToolkits(credentials, options, { signal }).catch(mapError),
    listConnections: (credentials: ToolsCredentials, ownerId: string, signal: AbortSignal) =>
      tools.listConnections(credentials, ownerId, { signal }).catch(mapError),
    startConnection: (
      credentials: ToolsCredentials,
      ownerId: string,
      toolkit: string,
      signal: AbortSignal,
    ) => tools.startConnection(credentials, ownerId, toolkit, { signal }).catch(mapError),
    removeConnection: (
      credentials: ToolsCredentials,
      ownerId: string,
      connectionId: string,
      signal: AbortSignal,
    ) => tools.removeConnection(credentials, ownerId, connectionId, { signal }).catch(mapError),
  };
}
