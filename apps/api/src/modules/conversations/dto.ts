import type {
  ConversationEvent,
  ConversationFile,
  ConversationMessage,
  ConversationParticipant,
  ConversationRun,
  ConversationSummary,
} from "@opensquad/core";
import type {
  ConversationEventRow,
  ConversationFileRow,
  ConversationMessageRow,
  ConversationRow,
  ConversationRunRow,
  ParticipantRow,
} from "@opensquad/db";

export class ConversationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const errors: Record<string, string> = {
  uncertain_mutation: "The provider may have accepted the request. Reconcile before continuing.",
  provider_failure: "The runtime operation failed.",
  stream_disconnected: "Runtime observation was interrupted. Reconnect to recover saved state.",
  history_requires_review: "Saved history cannot be matched safely and needs review.",
  worker_lost: "The execution worker is no longer observing this run. Reconciliation is required.",
  deadline_exceeded: "The run deadline was reached; cancellation was requested.",
  output_limit: "Runtime output exceeded the supported limit.",
  tools_key_required: "Add your Composio key in Tools, then send again.",
  tools_not_connected:
    "An app this bot uses isn't connected. Connect it in Tools, then send again.",
  tools_multiple_accounts:
    "More than one account is connected for an app this bot uses. Disconnect one in Tools, then send again.",
  tools_key_rejected: "Composio rejected your key. Check it in Tools, then send again.",
  tools_policy_mismatch:
    "Composio didn't apply this bot's app limits, so nothing ran. Send again to retry.",
  tools_unavailable: "Composio couldn't set up this bot's apps. Send again to retry.",
};

export const conversationDto = (row: ConversationRow): ConversationSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
});
export const participantDto = (row: ParticipantRow): ConversationParticipant => ({
  id: row.id,
  conversationId: row.conversationId,
  kind: row.kind,
  refId: row.refId,
  name: row.name,
  deletedAt: row.deletedAt?.toISOString() ?? null,
});
export const messageDto = (row: ConversationMessageRow): ConversationMessage => ({
  id: row.id,
  conversationId: row.conversationId,
  participantId: row.participantId,
  runId: row.runId,
  sequence: row.sequence.toString(),
  role: row.role,
  content: row.content,
  phase: row.phase,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});
export const conversationFileDto = (row: ConversationFileRow): ConversationFile => ({
  id: row.id,
  conversationId: row.conversationId,
  runId: row.runId,
  name: row.name,
  sizeBytes: row.sizeBytes,
  contentType: row.contentType,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});
export const runDto = (row: ConversationRunRow): ConversationRun => ({
  id: row.id,
  conversationId: row.conversationId,
  agentParticipantId: row.agentParticipantId,
  clientRequestId: row.clientRequestId,
  status: row.status,
  observation: row.observation,
  active: row.active,
  cancelRequested: row.cancelRequested,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  deadlineAt: row.deadlineAt.toISOString(),
  usage: row.usage,
  error: row.errorCode
    ? {
        code: row.errorCode in errors ? row.errorCode : "provider_failure",
        message: errors[row.errorCode] ?? errors.provider_failure ?? "Runtime failure",
      }
    : null,
});
export const eventDto = (row: ConversationEventRow): ConversationEvent => ({
  id: row.sequence.toString(),
  type: row.type,
  conversationId: row.conversationId,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
  payload: row.payload,
});
