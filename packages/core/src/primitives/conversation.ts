export type ConversationRunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";
export type RunObservation = "connected" | "disconnected" | "reconciliation_required";

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
}

export interface ConversationParticipant {
  id: string;
  conversationId: string;
  kind: "user" | "agent";
  refId: string;
  name: string;
  deletedAt: string | null;
}

export type MessageContentPart = {
  index: number;
  completed: boolean;
} & ({ type: "text"; text: string } | { type: "image"; url: string });

export interface ConversationMessage {
  id: string;
  conversationId: string;
  participantId: string;
  runId: string;
  sequence: string;
  role: "user" | "assistant";
  content: MessageContentPart[];
  phase: "commentary" | "final" | null;
  status: "running" | "completed" | "incomplete";
  createdAt: string;
}

export interface ConversationRun {
  id: string;
  conversationId: string;
  agentParticipantId: string;
  clientRequestId: string;
  status: ConversationRunStatus;
  observation: RunObservation;
  active: boolean;
  cancelRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  error: { code: string; message: string } | null;
}

export interface ConversationSnapshot {
  conversation: ConversationSummary;
  participants: ConversationParticipant[];
  activeRun: ConversationRun | null;
  latestMessages: ConversationMessage[];
  nextMessageCursor: string | null;
}

export type ConversationEventType =
  | "conversation.snapshot"
  | "participant.updated"
  | "message.created"
  | "message.delta"
  | "message.text.completed"
  | "message.completed"
  | "run.updated"
  | "stream.reset";
export interface ConversationEvent {
  id: string;
  type: ConversationEventType;
  conversationId: string;
  runId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}
