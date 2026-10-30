import pino from 'pino';
import { buildCatalog, loadProducts, type Catalog } from '../catalog/catalog.ts';
import { alert, audit, getSettings, setSetting, SYSTEM, type Actor, type DB } from '../db/index.ts';
import { parseInquiry, type ParseResult } from '../parser/parser.ts';
import { buildReply, type BuildResult } from '../quote/build.ts';
import { loadTemplates } from '../quote/store.ts';
import { isDuplicate, rateLimitProblem, withinBusinessHours } from './safety.ts';
import type { IncomingMessage, Transport } from './transport.ts';

const log = pino({ name: 'engine', level: process.env.LOG_LEVEL ?? 'info' });

interface GroupRow { id: number; wa_jid: string; name: string; auto_reply: number; category: string }
interface MessageRow { id: number; wa_msg_id: string; group_id: number; sender: string; from_me: number; text: string }
interface ReplyRow {
  id: number; message_id: number; group_id: number; kind: string; body: string; status: string; send_at: string;
  typing_started: number; created_at: string;
}

export type Outcome = 'quoted' | 'booking' | 'held' | 'ignored' | 'unmatched' | 'skipped';

export interface HandleResult { outcome: Outcome; messageId?: number; replyId?: number; reason?: string }

/**
 * The bot: turns incoming group messages into scheduled replies, and sends scheduled replies
 * from a queue kept in the database (so a restart neither loses nor double-sends a reply).
 */
export class Engine {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private db: DB, readonly transport: Transport, private now: () => Date = () => new Date()) {
    transport.onMessage((m) => {
      try { this.handleIncoming(m); } catch (e) { log.error({ err: e, id: m.id }, 'failed to handle message'); }
    });
    transport.onStatus((s) => {
      log.info({ state: s.state }, 'whatsapp connection');
      if (s.state === 'open') this.syncGroups().catch((e) => log.warn({ err: e }, 'group sync failed'));
    });
  }

  catalog(): Catalog {
    return buildCatalog(loadProducts(this.db), getSettings(this.db).known_brands);
  }

  start(intervalMs = 500) {
    // A reply caught mid-send by a crash may or may not have gone out: never resend it automatically.
    const stuck = this.db.prepare(`UPDATE replies SET status = 'failed', reason = 'Interrupted while sending; check the group before resending'
      WHERE status = 'sending'`).run();
    if (stuck.changes) alert(this.db, 'warn', `${stuck.changes} reply(ies) were interrupted by a restart and need checking`);
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ---------- inbound ----------

  handleIncoming(m: IncomingMessage): HandleResult {
    const db = this.db;
    const text = m.text?.trim();
    if (!text || !m.chatId.endsWith('@g.us')) return { outcome: 'ignored', reason: 'Not a group text message' };
    const s = getSettings(db);

    let group = db.prepare('SELECT * FROM groups WHERE wa_jid = ?').get(m.chatId) as GroupRow | undefined;
    if (!group) {
      db.prepare('INSERT INTO groups(wa_jid, name) VALUES(?, ?) ON CONFLICT(wa_jid) DO NOTHING').run(m.chatId, m.chatId);
      group = db.prepare('SELECT * FROM groups WHERE wa_jid = ?').get(m.chatId) as unknown as GroupRow;
    }
    const isTest = s.test_group_jid === group.wa_jid;
    if (!group.auto_reply && !isTest) return { outcome: 'ignored', reason: 'Auto-reply is off for this group' };
    if (m.fromMe && !isTest) return { outcome: 'ignored', reason: 'Own message' };

    // Loop protection: never answer our own quotes, or anything formatted like one.
    if (db.prepare('SELECT 1 FROM replies WHERE sent_msg_id = ?').get(m.id)) return { outcome: 'ignored', reason: 'Bot reply' };
    if (text.startsWith(`*${s.business_name}*`) || /quotation for \d+ items|\(\+ ?\d+% gst\)/i.test(text))
      return { outcome: 'ignored', reason: 'Looks like a quote' };

    const ins = db.prepare(`INSERT INTO messages(wa_msg_id, group_id, sender, sender_name, from_me, text, received_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(wa_msg_id) DO NOTHING`)
      .run(m.id, group.id, m.sender, m.senderName ?? null, m.fromMe ? 1 : 0, text, m.timestamp.toISOString());
    if (!ins.changes) return { outcome: 'ignored', reason: 'Already handled this message' };
    const messageId = Number(ins.lastInsertRowid);

    const catalog = this.catalog();
    const parse = parseInquiry(text, catalog);
    const built = buildReply(parse, catalog, s, loadTemplates(db), this.now());
    db.prepare('UPDATE messages SET parse_json = ?, intent = ?, confidence = ? WHERE id = ?')
      .run(JSON.stringify(parse), parse.intent, parse.confidence, messageId);

    return this.decide(messageId, group, m.sender, text, parse, built);
  }

  private setOutcome(messageId: number, outcome: Outcome) {
    this.db.prepare('UPDATE messages SET outcome = ? WHERE id = ?').run(outcome, messageId);
  }

  private decide(messageId: number, group: GroupRow, sender: string, text: string, parse: ParseResult, built: BuildResult,
    force = false): HandleResult {
    const db = this.db;
    if (built.kind === 'none') {
      const outcome: Outcome = parse.confidence === 'low' ? 'unmatched' : 'ignored';
      this.setOutcome(messageId, outcome);
      return { outcome, messageId, reason: built.reasons.join('; ') };
    }

    const s = getSettings(db);
    const now = this.now();
    if (!force && isDuplicate(db, s, group.id, sender, text, now, messageId)) {
      this.setOutcome(messageId, 'skipped');
      return { outcome: 'skipped', messageId, reason: `Same question from the same sender within ${s.duplicate_window_minutes} min` };
    }

    if (built.kind === 'booking' && !force) {
      const ins = db.prepare('INSERT INTO approvals(message_id, product_id, quantity, quantity_kg) VALUES(?,?,?,?)');
      for (const it of parse.items.length ? parse.items : [null]) {
        ins.run(messageId, it?.productId ?? null, it?.quantity ? `${it.quantity.value} ${it.quantity.unit}` : null, it?.quantity?.kg ?? null);
      }
      alert(db, 'info', `New booking request in ${group.name}: "${text.slice(0, 80)}"`);
    }

    let status = 'scheduled';
    let reason: string | null = null;
    if (built.kind === 'held') { status = 'held'; reason = built.reasons.join('; '); }
    else if (s.kill_switch) { status = 'held'; reason = 'Kill switch is on'; }
    else if (!force && !withinBusinessHours(s, now)) { status = 'held'; reason = 'Outside business hours'; }
    else if (!force) {
      const rl = rateLimitProblem(db, s, group.id, now);
      if (rl) { status = 'held'; reason = rl; }
    }

    const sendAt = new Date(now.getTime() + s.delay_seconds * 1000).toISOString();
    const r = db.prepare(`INSERT INTO replies(message_id, group_id, kind, body, template_version, status, reason, send_at, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(messageId, group.id, built.kind === 'booking' ? 'booking' : 'quote', built.body ?? '',
      built.templateVersion, status, reason, sendAt, now.toISOString());
    const replyId = Number(r.lastInsertRowid);

    const outcome: Outcome = status === 'held' ? 'held' : built.kind === 'booking' ? 'booking' : 'quoted';
    this.setOutcome(messageId, built.kind === 'booking' ? 'booking' : outcome);
    if (built.kind === 'held') alert(db, 'warn', `Reply held in ${group.name}: ${reason}`);
    return { outcome, messageId, replyId, reason: reason ?? undefined };
  }

  /** Operator action: rebuild a held/failed reply from current prices and send it now (still respects the kill switch). */
  resend(replyId: number, actor: Actor): HandleResult {
    const db = this.db;
    const old = db.prepare('SELECT * FROM replies WHERE id = ?').get(replyId) as ReplyRow | undefined;
    if (!old) throw new Error('Reply not found');
    if (!['held', 'failed', 'cancelled'].includes(old.status)) throw new Error(`Reply is ${old.status}`);
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(old.message_id) as unknown as MessageRow;
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(old.group_id) as unknown as GroupRow;
    db.prepare("UPDATE replies SET status = 'cancelled', reason = COALESCE(reason, '') || ' (replaced)' WHERE id = ?").run(replyId);
    const catalog = this.catalog();
    const parse = parseInquiry(msg.text, catalog);
    const built = buildReply(parse, catalog, getSettings(db), loadTemplates(db), this.now());
    audit(db, actor, 'reply.resend', `reply:${replyId}`);
    return this.decide(msg.id, group, msg.sender, msg.text, parse, built, true);
  }

  cancel(replyId: number, actor: Actor) {
    const r = this.db.prepare("UPDATE replies SET status = 'cancelled', reason = 'Cancelled by ' || ? WHERE id = ? AND status IN ('scheduled','held')")
      .run(actor.name, replyId);
    if (!r.changes) throw new Error('Only scheduled or held replies can be cancelled');
    audit(this.db, actor, 'reply.cancel', `reply:${replyId}`);
  }

  // ---------- outbound queue ----------

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.processQueue(); } catch (e) { log.error({ err: e }, 'queue error'); } finally { this.ticking = false; }
  }

  async processQueue() {
    const db = this.db;
    const s = getSettings(db);
    const now = this.now();
    if (s.kill_switch) {
      db.prepare("UPDATE replies SET status = 'cancelled', reason = 'Kill switch turned on' WHERE status = 'scheduled'").run();
      return;
    }
    const open = this.transport.status().state === 'open';
    const due = db.prepare("SELECT * FROM replies WHERE status = 'scheduled' ORDER BY send_at").all() as unknown as ReplyRow[];

    for (const r of due) {
      const group = db.prepare('SELECT wa_jid FROM groups WHERE id = ?').get(r.group_id) as { wa_jid: string };
      if (!open) {
        if (now.getTime() - Date.parse(r.created_at) > 5 * 60_000) {
          db.prepare("UPDATE replies SET status = 'failed', reason = 'WhatsApp not connected' WHERE id = ?").run(r.id);
        }
        continue;
      }
      if (s.typing_on && !r.typing_started) {
        db.prepare('UPDATE replies SET typing_started = 1 WHERE id = ?').run(r.id);
        await this.transport.setTyping(group.wa_jid, true).catch(() => {});
      }
      if (Date.parse(r.send_at) > now.getTime()) continue;

      const claimed = db.prepare("UPDATE replies SET status = 'sending' WHERE id = ? AND status = 'scheduled'").run(r.id);
      if (!claimed.changes) continue;
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(r.message_id) as unknown as MessageRow;
      try {
        const sentId = await this.transport.sendText(group.wa_jid, r.body, {
          id: msg.wa_msg_id, chatId: group.wa_jid, sender: msg.sender, fromMe: !!msg.from_me, text: msg.text,
        });
        db.prepare("UPDATE replies SET status = 'sent', sent_at = ?, sent_msg_id = ? WHERE id = ?").run(new Date().toISOString(), sentId, r.id);
      } catch (e) {
        db.prepare("UPDATE replies SET status = 'failed', reason = ? WHERE id = ?").run(`Send failed: ${(e as Error).message}`, r.id);
        alert(db, 'critical', `Could not send a reply: ${(e as Error).message}`);
      } finally {
        if (s.typing_on) await this.transport.setTyping(group.wa_jid, false).catch(() => {});
      }
    }
  }

  // ---------- groups ----------

  async syncGroups(actor: Actor = SYSTEM) {
    const groups = await this.transport.listGroups();
    const up = this.db.prepare(`INSERT INTO groups(wa_jid, name, members, synced_at) VALUES(?,?,?,?)
      ON CONFLICT(wa_jid) DO UPDATE SET name = excluded.name, members = excluded.members, synced_at = excluded.synced_at`);
    const at = new Date().toISOString();
    for (const g of groups) up.run(g.jid, g.name, g.members, at);
    if (this.transport.kind === 'mock' && !getSettings(this.db).test_group_jid) {
      setSetting(this.db, 'test_group_jid', 'test-group@g.us');
      this.db.prepare("UPDATE groups SET category = 'test' WHERE wa_jid = 'test-group@g.us'").run();
    }
    audit(this.db, actor, 'groups.sync', 'groups', undefined, { count: groups.length });
    return groups.length;
  }
}
