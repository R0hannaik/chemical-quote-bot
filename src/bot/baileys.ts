import { rmSync } from 'node:fs';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WAMessage, type WASocket,
} from 'baileys';
import pino from 'pino';
import type { GroupInfo, IncomingMessage, QuotedRef, Transport, TransportStatus } from './transport.ts';

const log = pino({ name: 'whatsapp', level: process.env.LOG_LEVEL ?? 'info' });

/**
 * WhatsApp linked-device client built on Baileys (unofficial). Reconnects with backoff and keeps
 * its session on disk so restarts do not need a new QR scan.
 */
export class BaileysTransport implements Transport {
  readonly kind = 'baileys';
  private sock: WASocket | null = null;
  private st: TransportStatus = { state: 'disconnected', since: new Date() };
  private msgCbs: ((m: IncomingMessage) => void)[] = [];
  private statusCbs: ((s: TransportStatus) => void)[] = [];
  private retries = 0;
  private stopped = false;

  constructor(private authDir: string) {}

  status() { return this.st; }
  onMessage(cb: (m: IncomingMessage) => void) { this.msgCbs.push(cb); }
  onStatus(cb: (s: TransportStatus) => void) { this.statusCbs.push(cb); }

  private setStatus(patch: Partial<TransportStatus> & { state: TransportStatus['state'] }) {
    const changed = patch.state !== this.st.state;
    this.st = { ...this.st, ...patch, since: changed ? new Date() : this.st.since };
    if (patch.state !== 'qr') delete this.st.qr;
    for (const cb of this.statusCbs) cb(this.st);
  }

  async start() {
    this.stopped = false;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    this.setStatus({ state: 'connecting' });
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu('Chrome'),
      logger: log.child({ module: 'baileys' }, { level: 'warn' }) as any,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.setStatus({ state: 'qr', qr: u.qr });
      if (u.connection === 'open') {
        this.retries = 0;
        this.setStatus({ state: 'open', me: sock.user ? { id: sock.user.id, name: sock.user.name } : undefined });
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          rmSync(this.authDir, { recursive: true, force: true });
          this.setStatus({ state: 'logged_out', me: undefined });
          if (!this.stopped) setTimeout(() => void this.start(), 1000); // show a fresh QR
          return;
        }
        this.setStatus({ state: 'disconnected' });
        if (this.stopped) return;
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1000 * 2 ** this.retries++);
        log.warn({ code, delay }, 'connection closed, reconnecting');
        setTimeout(() => void this.start(), delay);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const parsed = this.toIncoming(m);
        if (parsed) for (const cb of this.msgCbs) cb(parsed);
      }
    });
  }

  private toIncoming(m: WAMessage): IncomingMessage | null {
    const chatId = m.key.remoteJid;
    if (!chatId?.endsWith('@g.us') || !m.message || !m.key.id) return null;
    const msg = m.message;
    const text = msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? null;
    if (!text) return null;
    const ts = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Number(m.messageTimestamp ?? 0);
    return {
      id: m.key.id,
      chatId,
      sender: m.key.participant ?? m.key.participantAlt ?? 'unknown',
      senderName: m.pushName ?? undefined,
      fromMe: !!m.key.fromMe,
      text,
      timestamp: ts ? new Date(ts * 1000) : new Date(),
    };
  }

  private requireSock(): WASocket {
    if (!this.sock || this.st.state !== 'open') throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  async sendText(chatId: string, text: string, quoted?: QuotedRef) {
    const sock = this.requireSock();
    const q = quoted ? ({
      key: { remoteJid: quoted.chatId, id: quoted.id, participant: quoted.sender, fromMe: quoted.fromMe },
      message: { conversation: quoted.text },
    } as WAMessage) : undefined;
    const sent = await sock.sendMessage(chatId, { text }, q ? { quoted: q } : undefined);
    return sent?.key.id ?? '';
  }

  async setTyping(chatId: string, on: boolean) {
    if (!this.sock || this.st.state !== 'open') return;
    await this.sock.sendPresenceUpdate(on ? 'composing' : 'paused', chatId);
  }

  async listGroups(): Promise<GroupInfo[]> {
    const groups = await this.requireSock().groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ jid: g.id, name: g.subject, members: g.participants?.length ?? 0 }));
  }

  async stop() {
    this.stopped = true;
    this.sock?.end(undefined);
    this.sock = null;
    this.setStatus({ state: 'disconnected' });
  }

  async logout() {
    const sock = this.sock;
    if (sock && this.st.state === 'open') await sock.logout().catch(() => {});
    else {
      rmSync(this.authDir, { recursive: true, force: true });
      await this.stop();
      await this.start();
    }
  }
}
