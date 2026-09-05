import type { MemoryProvider, MemoryRecord } from "@opensquad/core";

/** Mem0 memory provider. The only place the Mem0 SDK may be imported. */
export class Mem0Provider implements MemoryProvider {
  readonly name = "mem0";

  constructor(protected readonly options: { apiKey: string }) {}

  add(_agentId: string, _content: string): Promise<MemoryRecord> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  search(_agentId: string, _query: string, _limit?: number): Promise<MemoryRecord[]> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  clear(_agentId: string): Promise<void> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
