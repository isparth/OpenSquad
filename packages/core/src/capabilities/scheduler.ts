import type { Routine } from "../primitives/index.js";

export interface ScheduleHandle {
  externalId: string;
}

/** Scheduler capability. Routines are core; this only runs them. Default provider: Trigger.dev. */
export interface SchedulerProvider {
  readonly name: string;
  schedule(routine: Routine): Promise<ScheduleHandle>;
  unschedule(handle: ScheduleHandle): Promise<void>;
}
