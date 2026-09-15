import { type Database, requestRateLimits } from "@opensquad/db";
import { sql } from "drizzle-orm";
import { ConversationError } from "./dto.js";

export async function chargeRequest(db: Database, ownerId: string): Promise<void> {
  const expired = sql`${requestRateLimits.windowStart} < clock_timestamp() - interval '1 minute'`;
  const rows = await db
    .insert(requestRateLimits)
    .values({ ownerId, windowStart: sql`clock_timestamp()`, count: 1 })
    .onConflictDoUpdate({
      target: requestRateLimits.ownerId,
      set: {
        count: sql`case when ${expired} then 1 else ${requestRateLimits.count} + 1 end`,
        windowStart: sql`case when ${expired} then clock_timestamp() else ${requestRateLimits.windowStart} end`,
      },
      setWhere: sql`(${expired}) or ${requestRateLimits.count} < 120`,
    })
    .returning({ ownerId: requestRateLimits.ownerId });
  if (!rows.length) throw new ConversationError(429, "Request limit reached; retry later");
}
