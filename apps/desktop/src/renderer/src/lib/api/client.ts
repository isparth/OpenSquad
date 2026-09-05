export interface Health {
  ok: boolean;
  db: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thin fetch wrapper for the OpenSquad API. Auth headers get added here once Clerk is wired in. */
export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  health(): Promise<Health> {
    return this.get("/health");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new ApiError(res.status, `API returned status ${res.status}`);
    return res.json() as Promise<T>;
  }
}

let cached: Promise<ApiClient> | undefined;

/** Resolves the API base URL from the main process once, then reuses the client. */
export function getApiClient(): Promise<ApiClient> {
  cached ??= window.opensquad.getApiBaseUrl().then((url) => new ApiClient(url));
  return cached;
}
