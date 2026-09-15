import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ConversationEvent, ConversationSnapshot } from "@opensquad/core";
import type { Database } from "@opensquad/db";
import { ConversationError } from "./dto.js";
import { conversationsService } from "./service.js";

function frame(event: ConversationEvent): string {
  const { id, type, ...data } = event;
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function eventStreams(db: Database) {
  const service = conversationsService(db);
  const active = new Map<Readable, { ownerId: string; controller: AbortController }>();
  return {
    open(
      ownerId: string,
      conversationId: string,
      initial: { sequence: string; snapshot: ConversationSnapshot },
      after?: bigint,
    ) {
      if ([...active.values()].filter((entry) => entry.ownerId === ownerId).length >= 5)
        throw new ConversationError(429, "Too many active event streams");
      const controller = new AbortController();
      async function* generate() {
        let cursor = after ?? BigInt(initial.sequence);
        let heartbeat = Date.now();
        let wroteFrame = after === undefined;
        const snapshotFrame = (snapshot: typeof initial) =>
          frame({
            id: snapshot.sequence,
            type: "conversation.snapshot",
            conversationId,
            runId: null,
            createdAt: new Date().toISOString(),
            payload: { ...snapshot.snapshot },
          });
        try {
          if (after === undefined) yield snapshotFrame(initial);
          while (!controller.signal.aborted) {
            const window = await service.eventWindow(ownerId, conversationId, cursor, 1);
            const event = window.items[0];
            if ((event && BigInt(event.id) !== cursor + 1n) || (!event && cursor < window.sequence)) {
              const snapshot = await service.snapshot(ownerId, conversationId);
              yield `event: stream.reset\ndata: ${JSON.stringify({ conversationId, runId: null, createdAt: new Date().toISOString(), payload: { reason: "cursor_expired" } })}\n\n`;
              yield snapshotFrame(snapshot);
              cursor = BigInt(snapshot.sequence);
              wroteFrame = true;
            } else if (event) {
              yield frame(event);
              cursor = BigInt(event.id);
              wroteFrame = true;
            } else {
              if (!wroteFrame || Date.now() - heartbeat >= 15_000) {
                yield ": keep-alive\n\n";
                wroteFrame = true;
                heartbeat = Date.now();
              }
              await delay(200, undefined, { signal: controller.signal });
            }
          }
        } catch {
          if (!controller.signal.aborted) throw new Error("Product event stream interrupted");
        } finally {
          controller.abort();
        }
      }
      const stream = Readable.from(generate(), { objectMode: false, highWaterMark: 16 * 1024 });
      active.set(stream, { ownerId, controller });
      stream.once("close", () => {
        controller.abort();
        active.delete(stream);
      });
      return stream;
    },
    async close() {
      await Promise.all(
        [...active].map(
          ([stream, { controller }]) =>
            new Promise<void>((resolve) => {
              if (stream.closed) {
                resolve();
                return;
              }
              stream.once("close", resolve);
              controller.abort();
              stream.destroy();
            }),
        ),
      );
    },
  };
}
