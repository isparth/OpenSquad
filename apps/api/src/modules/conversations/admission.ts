import { randomUUID } from "node:crypto";
import { type AgentRuntimeProvider, sortToolGrants } from "@opensquad/core";
import {
  agents,
  conversationMessages,
  conversationRuns,
  conversations,
  type Database,
  participants,
  runtimeSessions,
} from "@opensquad/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { memorySnapshot } from "../memory/service.js";
import { ConversationError, messageDto, runDto } from "./dto.js";
import { appendEvent, lockConversation, nextMessageSequence } from "./persistence.js";

export function runAdmission(
  db: Database,
  config: {
    provider: string;
    model: string;
    features: AgentRuntimeProvider["features"];
  },
) {
  return async (
    ownerId: string,
    conversationId: string,
    input: { text: string; clientRequestId: string },
    hasToolsKey = false,
  ) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`);
      const [member] = await tx
        .select({ participant: participants })
        .from(participants)
        .innerJoin(conversations, eq(conversations.id, participants.conversationId))
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.ownerId, ownerId),
            eq(participants.kind, "agent"),
          ),
        );
      if (!member) throw new ConversationError(404, "Conversation not found");
      const [agent] = member.participant.agentId
        ? await tx
            .select()
            .from(agents)
            .where(and(eq(agents.id, member.participant.agentId), eq(agents.ownerId, ownerId)))
            .for("share")
        : [];
      await lockConversation(tx, ownerId, conversationId);
      const [existing] = await tx
        .select()
        .from(conversationRuns)
        .where(
          and(
            eq(conversationRuns.conversationId, conversationId),
            eq(conversationRuns.clientRequestId, input.clientRequestId),
          ),
        );
      if (existing) {
        if (existing.input !== input.text)
          throw new ConversationError(409, "Request ID was already used for different input");
        const [message] = await tx
          .select()
          .from(conversationMessages)
          .where(
            and(eq(conversationMessages.runId, existing.id), eq(conversationMessages.role, "user")),
          );
        if (!message) throw new Error("Admitted input is missing");
        return {
          fresh: false,
          sessionCreated: false,
          agentId: member.participant.agentId,
          message: messageDto(message),
          run: runDto(existing),
        };
      }
      if (!agent || member.participant.deletedAt)
        throw new ConversationError(404, "Bot is no longer available");
      const [active] = await tx
        .select({ id: conversationRuns.id })
        .from(conversationRuns)
        .where(
          and(
            eq(conversationRuns.conversationId, conversationId),
            eq(conversationRuns.active, true),
          ),
        );
      if (active)
        throw new ConversationError(
          409,
          "Reconcile or finish the existing run before sending more input",
        );
      const [recent] = await tx
        .select({ count: count() })
        .from(conversationRuns)
        .where(
          and(
            eq(conversationRuns.ownerId, ownerId),
            gte(conversationRuns.createdAt, sql`clock_timestamp() - interval '1 minute'`),
          ),
        );
      const [running] = await tx
        .select({ count: count() })
        .from(conversationRuns)
        .where(and(eq(conversationRuns.ownerId, ownerId), eq(conversationRuns.active, true)));
      if ((recent?.count ?? 0) >= 20 || (running?.count ?? 0) >= 5)
        throw new ConversationError(429, "Runtime admission limit reached");
      let [session] = await tx
        .select()
        .from(runtimeSessions)
        .where(eq(runtimeSessions.conversationId, conversationId));
      const sessionCreated = !session;
      const environment = agent.sandboxEnabled ? "hosted" : "none";
      if (
        session &&
        (session.provider !== config.provider ||
          session.model !== config.model ||
          session.instructions !== agent.instructions ||
          session.environment !== environment ||
          JSON.stringify(sortToolGrants(session.toolGrants)) !==
            JSON.stringify(sortToolGrants(agent.toolGrants)))
      )
        throw new ConversationError(
          409,
          "Bot or runtime settings changed; start a new conversation",
        );
      // A session's frozen grants win over the agent's current ones (drift was checked above).
      if ((session?.toolGrants ?? agent.toolGrants).length > 0 && !session?.externalId) {
        if (!config.features.mcp)
          throw new ConversationError(409, "This runtime does not support apps");
        if (!hasToolsKey)
          throw new ConversationError(428, "Add your Composio key in Tools to use this bot's apps");
      }
      if (!session) {
        if (environment === "hosted" && !config.features.hostedEnvironment)
          throw new ConversationError(
            409,
            "This runtime does not support sandboxes; turn off the bot's sandbox",
          );
        if (environment === "none" && !config.features.environmentless)
          throw new ConversationError(
            409,
            "This runtime requires a sandbox; turn on the bot's sandbox",
          );
        [session] = await tx
          .insert(runtimeSessions)
          .values({
            conversationId,
            agentParticipantId: member.participant.id,
            provider: config.provider,
            model: config.model,
            instructions: agent.instructions,
            memorySnapshot: await memorySnapshot(tx, ownerId, agent.id),
            environment,
            toolGrants: agent.toolGrants,
          })
          .returning();
      }
      if (!session) throw new Error("Runtime reference insert failed");
      const [run] = await tx
        .insert(conversationRuns)
        .values({
          id: randomUUID(),
          conversationId,
          ownerId,
          agentParticipantId: member.participant.id,
          sessionId: session.id,
          input: input.text,
          clientRequestId: input.clientRequestId,
          deadlineAt: sql`clock_timestamp() + interval '10 minutes'`,
        })
        .returning();
      const [user] = await tx
        .select()
        .from(participants)
        .where(
          and(
            eq(participants.conversationId, conversationId),
            eq(participants.kind, "user"),
            eq(participants.refId, ownerId),
          ),
        );
      if (!run || !user) throw new Error("Run admission failed");
      const [message] = await tx
        .insert(conversationMessages)
        .values({
          conversationId,
          participantId: user.id,
          runId: run.id,
          sessionId: session.id,
          sequence: await nextMessageSequence(tx, conversationId),
          role: "user",
          status: "completed",
          content: [{ index: 0, type: "text", text: input.text, completed: true }],
        })
        .returning();
      if (!message) throw new Error("Message insert failed");
      await appendEvent(tx, conversationId, "message.created", run.id, {
        message: messageDto(message),
      });
      await appendEvent(tx, conversationId, "run.updated", run.id, { run: runDto(run) });
      return {
        fresh: true,
        sessionCreated,
        agentId: agent.id,
        message: messageDto(message),
        run: runDto(run),
      };
    });
}
