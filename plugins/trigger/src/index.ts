import type { Routine, ScheduleHandle, SchedulerProvider } from "@opensquad/core";

/** Trigger.dev scheduler provider. The only place the Trigger.dev SDK may be imported. */
export class TriggerProvider implements SchedulerProvider {
  readonly name = "trigger";

  constructor(protected readonly options: { secretKey: string }) {}

  schedule(_routine: Routine): Promise<ScheduleHandle> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  unschedule(_handle: ScheduleHandle): Promise<void> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
