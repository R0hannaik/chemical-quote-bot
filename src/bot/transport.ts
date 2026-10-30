/**
 * Every WhatsApp call goes through this interface, so Baileys can be swapped for whatsmeow
 * or the official Cloud API without touching the parser, engine or dashboard.
 */

export interface IncomingMessage {
  id: string;
  chatId: string;          // group JID, ends in @g.us
  sender: string;          // participant JID
  senderName?: string;
  fromMe: boolean;
  text: string;
  timestamp: Date;
}

export interface GroupInfo { jid: string; name: string; members: number }

export type ConnectionState = 'disconnected' | 'connecting' | 'qr' | 'open' | 'logged_out';

export interface TransportStatus {
  state: ConnectionState;
  qr?: string;             // raw QR payload while waiting to be scanned
  me?: { id: string; name?: string };
  since: Date;
}

export interface QuotedRef { id: string; chatId: string; sender: string; fromMe: boolean; text: string }

export interface Transport {
  readonly kind: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Unlinks the device; a new QR scan is needed afterwards. */
  logout(): Promise<void>;
  status(): TransportStatus;
  onMessage(cb: (m: IncomingMessage) => void): void;
  onStatus(cb: (s: TransportStatus) => void): void;
  /** Sends text, as a WhatsApp reply to `quoted` when given. Returns the new message id. */
  sendText(chatId: string, text: string, quoted?: QuotedRef): Promise<string>;
  setTyping(chatId: string, on: boolean): Promise<void>;
  listGroups(): Promise<GroupInfo[]>;
}
