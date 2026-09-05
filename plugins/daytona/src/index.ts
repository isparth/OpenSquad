import type { ExecResult, SandboxHandle, SandboxProvider } from "@opensquad/core";

/** Daytona sandbox provider. The only place the Daytona SDK may be imported. */
export class DaytonaProvider implements SandboxProvider {
  readonly name = "daytona";

  constructor(protected readonly options: { apiKey: string }) {}

  create(_agentId: string): Promise<SandboxHandle> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  exec(_handle: SandboxHandle, _command: string): Promise<ExecResult> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  destroy(_handle: SandboxHandle): Promise<void> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
