import { randomUUID } from 'node:crypto';
import type { GroupInfo, IncomingMessage, QuotedRef, Transport, TransportStatus } from './transport.ts';

export interface SentMessage { id: string; chatId: string; text: string; quotedId?: string; at: Date }

/**
 * Stand-in transport for local testing and the automated tests: "sends" into memory
 * and lets the dashboard inject messages as if they arrived from a group.
 */
export class MockTransport implements Transport {
  readonly kind = 'mock';
  sent: SentMessage[] = [];
  typing: { chatId: string; on: boolean }[] = [];
  groups: GroupInfo[] = [
    { jid: 'test-group@g.us', name: 'Pawan Chemicals — Test Group', members: 3 },
    { jid: 'brokers-1@g.us', name: 'Chemical Traders Group', members: 212 },
    { jid: 'brokers-2@g.us', name: 'Mumbai Solvents & Acids', members: 148 },
    { jid: 'family@g.us', name: 'Family', members: 9 },
  ];
  private msgCbs: ((m: IncomingMessage) => void)[] = [];
  private statusCbs: ((s: TransportStatus) => void)[] = [];
  private st: TransportStatus = { state: 'disconnected', since: new Date() };
  failNextSend = false;

  async start() { this.setStatus({ state: 'open', me: { id: '910000000000@s.whatsapp.net', name: 'Mock number' }, since: new Date() }); }
  async stop() { this.setStatus({ state: 'disconnected', since: new Date() }); }
  async logout() { this.setStatus({ state: 'logged_out', since: new Date() }); }
  status() { return this.st; }
  onMessage(cb: (m: IncomingMessage) => void) { this.msgCbs.push(cb); }
  onStatus(cb: (s: TransportStatus) => void) { this.statusCbs.push(cb); }

  async sendText(chatId: string, text: string, quoted?: QuotedRef) {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('mock send failure'); }
    const id = `mock-${randomUUID()}`;
    this.sent.push({ id, chatId, text, quotedId: quoted?.id, at: new Date() });
    return id;
  }
  async setTyping(chatId: string, on: boolean) { this.typing.push({ chatId, on }); }
  async listGroups() { return this.groups; }

  /** Pretend a group member sent this. */
  inject(m: Partial<IncomingMessage> & { chatId: string; text: string }) {
    const msg: IncomingMessage = {
      id: m.id ?? `in-${randomUUID()}`, sender: m.sender ?? '919800000001@s.whatsapp.net', senderName: m.senderName ?? 'Test Broker',
      fromMe: m.fromMe ?? false, timestamp: m.timestamp ?? new Date(), ...m,
    };
    for (const cb of this.msgCbs) cb(msg);
    return msg;
  }

  private setStatus(s: TransportStatus) { this.st = s; for (const cb of this.statusCbs) cb(s); }
}
