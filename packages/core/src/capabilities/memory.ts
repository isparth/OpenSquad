export interface MemoryRecord {
  id: string;
  content: string;
  score?: number;
}

/** Memory capability. Default provider: Mem0. */
export interface MemoryProvider {
  readonly name: string;
  add(agentId: string, content: string): Promise<MemoryRecord>;
  search(agentId: string, query: string, limit?: number): Promise<MemoryRecord[]>;
  clear(agentId: string): Promise<void>;
}
