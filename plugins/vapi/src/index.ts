import type { PhoneNumber, PhoneProvider } from "@opensquad/core";

/** Vapi phone provider. The only place the Vapi SDK may be imported. */
export class VapiProvider implements PhoneProvider {
  readonly name = "vapi";

  constructor(protected readonly options: { apiKey: string }) {}

  provision(_agentId: string): Promise<PhoneNumber> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  release(_phone: PhoneNumber): Promise<void> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
