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
