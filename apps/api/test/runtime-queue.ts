import type { RuntimeEvent, RuntimeEventStream } from "@opensquad/core";
import { vi } from "vitest";

export class RuntimeQueue implements RuntimeEventStream {
  private items: Array<RuntimeEvent | Error> = [];
  private wake = () => {};
  private closed = false;
  readonly close = vi.fn(() => {
    this.closed = true;
    this.wake();
  });
  emit(event: RuntimeEvent) {
    if (!this.closed) {
      this.items.push(event);
      this.wake();
    }
  }
  fail(error: Error) {
    this.items.push(error);
    this.wake();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const item = this.items.shift();
      if (item instanceof Error) throw item;
      if (item) yield item;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
