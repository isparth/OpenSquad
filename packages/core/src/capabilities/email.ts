export interface Inbox {
  externalId: string;
  address: string;
}

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** Email capability. Default provider: AgentMail. */
export interface EmailProvider {
  readonly name: string;
  createInbox(agentId: string): Promise<Inbox>;
  send(inbox: Inbox, email: OutgoingEmail): Promise<{ messageId: string }>;
}
