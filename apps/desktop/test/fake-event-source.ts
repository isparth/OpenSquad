import { act } from "@testing-library/react";

export class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, EventListener[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    act(() => this.onopen?.());
  }
  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify({ payload }) });
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }
  error() {
    act(() => this.onerror?.());
  }
}
