import type { EmailProvider, Inbox, OutgoingEmail } from "@opensquad/core";

/** AgentMail email provider. The only place the AgentMail SDK may be imported. */
export class AgentMailProvider implements EmailProvider {
  readonly name = "agentmail";

  constructor(protected readonly options: { apiKey: string }) {}

  createInbox(_agentId: string): Promise<Inbox> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }

  send(_inbox: Inbox, _email: OutgoingEmail): Promise<{ messageId: string }> {
    return Promise.reject(new Error(`${this.name}: not implemented`));
  }
}
