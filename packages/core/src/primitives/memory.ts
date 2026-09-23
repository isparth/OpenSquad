export type MemoryDocumentName = "profile" | "preferences" | "notes";
export type MemoryRevisionAuthor = "user" | "extraction" | "revert";

export interface MemoryDocument {
  name: MemoryDocumentName;
  scope: "shared" | "agent";
  content: string;
  version: number;
  limit: number;
  updatedAt: string | null;
}

export interface MemoryRevision {
  version: number;
  author: MemoryRevisionAuthor;
  content: string;
  createdAt: string;
}

export type MemoryUpdateStatus = "running" | "succeeded" | "failed";
export type MemoryUpdateTrigger = "auto" | "manual";

export interface MemoryUpdateChange {
  name: MemoryDocumentName;
  fromVersion: number;
  toVersion: number;
}

export interface MemoryUpdate {
  id: string;
  agentId: string;
  trigger: MemoryUpdateTrigger;
  status: MemoryUpdateStatus;
  changed: MemoryUpdateChange[];
  errorCode: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface MemoryReviewChange {
  name: MemoryDocumentName;
  fromVersion: number;
  toVersion: number;
  before: string | null;
  after: string | null;
  current: boolean;
}

export interface MemoryReview {
  updateId: string;
  agentId: string;
  agentName: string;
  trigger: MemoryUpdateTrigger;
  createdAt: string;
  finishedAt: string | null;
  sources: Array<{ conversationId: string; title: string | null; startedAt: string }>;
  changes: MemoryReviewChange[];
}
