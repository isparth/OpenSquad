export interface PhoneNumber {
  externalId: string;
  /** E.164 */
  number: string;
}

/** Phone capability. Default provider: Vapi. */
export interface PhoneProvider {
  readonly name: string;
  provision(agentId: string): Promise<PhoneNumber>;
  release(phone: PhoneNumber): Promise<void>;
}
