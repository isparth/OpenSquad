export interface SandboxHandle {
  /** Provider-side id. Stored in Postgres as a reference only. */
  externalId: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Sandbox capability. Default provider: Daytona. */
export interface SandboxProvider {
  readonly name: string;
  create(agentId: string): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: string): Promise<ExecResult>;
  destroy(handle: SandboxHandle): Promise<void>;
}
