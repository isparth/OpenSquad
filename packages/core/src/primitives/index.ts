// Core primitives. These belong to the platform and are never plugins.
// See llm_docs/SPEC.md section 1.

export type Id = string;
export type ISODate = string;

export interface Agent {
  id: Id;
  ownerId: Id;
  name: string;
  label?: string;
  description: string;
  avatarUrl?: string;
  instructions: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type ParticipantKind = "user" | "agent";

export interface Participant {
  id: Id;
  conversationId: Id;
  kind: ParticipantKind;
  /** userId or agentId depending on kind */
  refId: Id;
  joinedAt: ISODate;
}

export interface Conversation {
  id: Id;
  title?: string;
  createdAt: ISODate;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: Id;
  conversationId: Id;
  participantId: Id;
  role: MessageRole;
  content: string;
  createdAt: ISODate;
}

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface Task {
  id: Id;
  agentId: Id;
  conversationId?: Id;
  status: TaskStatus;
  input: string;
  createdAt: ISODate;
}

export interface Run {
  id: Id;
  taskId: Id;
  status: TaskStatus;
  startedAt: ISODate;
  finishedAt?: ISODate;
  error?: string;
}

export interface Routine {
  id: Id;
  agentId: Id;
  instructions: string;
  trigger: "schedule";
  /** cron expression */
  schedule: string;
  timezone: string;
  enabled: boolean;
  lastRunAt?: ISODate;
}

export interface Event {
  id: Id;
  type: string;
  payload: unknown;
  createdAt: ISODate;
}
