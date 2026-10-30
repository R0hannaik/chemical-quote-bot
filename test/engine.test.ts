import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/bot/engine.ts';
import { MockTransport } from '../src/bot/mock.ts';
import { getSettings, setSetting, SYSTEM, type DB } from '../src/db/index.ts';
import { freshDb, productId } from './helpers.ts';

const BROKERS = 'brokers-1@g.us';

/** 11:30 IST on a weekday, inside default business hours. */
function setup(start = '2026-10-30T06:00:00.000Z') {
  const db = freshDb();
  const clock = { t: new Date(start) };
  const transport = new MockTransport();
  const engine = new Engine(db, transport, () => clock.t);
  db.prepare("UPDATE price_rows SET updated_at = ?").run(clock.t.toISOString());
  return { db, clock, transport, engine };
}

async function ready(db: DB, transport: MockTransport, engine: Engine) {
  await transport.start();
  await engine.syncGroups();
  db.prepare('UPDATE groups SET auto_reply = 1 WHERE wa_jid = ?').run(BROKERS);
}

const advance = (clock: { t: Date }, ms: number) => { clock.t = new Date(clock.t.getTime() + ms); };
const replies = (db: DB) => db.prepare('SELECT * FROM replies ORDER BY id').all() as any[];

test('a price inquiry is quoted after the delay, as a reply to the message, with typing shown', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  const msg = transport.inject({ chatId: BROKERS, text: 'pg 20 drums wells rate?' });
  await engine.processQueue();
  assert.equal(transport.sent.length, 0, 'not before the delay');
  assert.deepEqual(transport.typing.at(-1), { chatId: BROKERS, on: true });
  advance(clock, 3_000);
  await engine.processQueue();
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].quotedId, msg.id);
  assert.match(transport.sent[0].text, /Wells \(China\)/);
  assert.match(transport.sent[0].text, /₹155\.00 \/ kg/);
  assert.match(transport.sent[0].text, /20 drums \(4,300 kg\)/);
  assert.equal(replies(db)[0].status, 'sent');
});

test('groups with auto-reply off get nothing', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  const r = engine.handleIncoming({ id: 'x1', chatId: 'brokers-2@g.us', sender: 's', fromMe: false, text: 'pa rate?', timestamp: new Date() });
  assert.equal(r.outcome, 'ignored');
  assert.equal(replies(db).length, 0);
});

test('a product with no price is held, not sent, and an alert is raised', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pta rate pls' });
  advance(clock, 10_000);
  await engine.processQueue();
  assert.equal(transport.sent.length, 0);
  const [r] = replies(db);
  assert.equal(r.status, 'held');
  assert.match(r.reason, /no price set/);
  assert.ok(db.prepare("SELECT 1 FROM alerts WHERE text LIKE '%held%'").get());
});

test('a zero price is held', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  db.prepare('UPDATE price_rows SET rate = 0 WHERE product_id = ?').run(productId(db, 'Melamine'));
  transport.inject({ chatId: BROKERS, text: 'melamine rate?' });
  assert.equal(replies(db)[0].status, 'held');
});

test('a stale price is held', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  advance(clock, 25 * 3_600_000);
  transport.inject({ chatId: BROKERS, text: 'tmp 1 ton rate' });
  const [r] = replies(db);
  assert.equal(r.status, 'held');
  assert.match(r.reason, /not confirmed/);
});

test('in a multi-item quote, one bad item holds the whole reply', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pta and pvc rate pls' });
  assert.equal(replies(db)[0].status, 'held');
});

test('resend after fixing the price sends the corrected quote', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pta rate pls' });
  db.prepare("INSERT INTO price_rows(product_id, origin, brand, rate, updated_at) VALUES(?, 'India', 'Reliance', 118, ?)")
    .run(productId(db, 'Purified Terephthalic'), clock.t.toISOString());
  const res = engine.resend(replies(db)[0].id, SYSTEM);
  assert.equal(res.outcome, 'quoted');
  advance(clock, 5_000);
  await engine.processQueue();
  assert.match(transport.sent[0].text, /₹118\.00/);
});

test('kill switch cancels queued replies and holds new ones', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pa rate?' });
  setSetting(db, 'kill_switch', true);
  advance(clock, 5_000);
  await engine.processQueue();
  assert.equal(transport.sent.length, 0);
  assert.equal(replies(db)[0].status, 'cancelled');
  advance(clock, 60_000);
  transport.inject({ chatId: BROKERS, text: 'ma rate?' });
  assert.equal(replies(db)[1].status, 'held');
  assert.equal(replies(db)[1].reason, 'Kill switch is on');
});

test('rate limit: second reply in the same group within 20 s is held', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pa rate?', sender: 'a' });
  transport.inject({ chatId: BROKERS, text: 'ma rate?', sender: 'b' });
  assert.equal(replies(db)[1].status, 'held');
  assert.match(replies(db)[1].reason, /Rate limit/);
});

test('rate limit: the 31st reply in an hour in one group is held', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  for (let i = 0; i < 31; i++) {
    transport.inject({ chatId: BROKERS, text: `pa ${i + 1} ton rate`, sender: `s${i}` });
    advance(clock, 21_000);
  }
  const rs = replies(db);
  assert.equal(rs.filter((r) => r.status === 'scheduled').length, 30);
  assert.match(rs[30].reason, /30 replies per hour/);
});

test('outside business hours inquiries are held', async () => {
  const { db, transport, engine } = setup('2026-10-30T17:00:00.000Z'); // 22:30 IST
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pa rate?' });
  assert.equal(replies(db)[0].reason, 'Outside business hours');
});

test('the same message delivered twice is answered once', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ id: 'dup-1', chatId: BROKERS, text: 'pa rate?' });
  transport.inject({ id: 'dup-1', chatId: BROKERS, text: 'pa rate?' });
  assert.equal(replies(db).length, 1);
});

test('the same question from the same sender within 10 minutes gets no second reply', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pa rate?', sender: 'a' });
  advance(clock, 120_000);
  const r = engine.handleIncoming({ id: 'again', chatId: BROKERS, sender: 'a', fromMe: false, text: 'PA rate?', timestamp: clock.t });
  assert.equal(r.outcome, 'skipped');
});

test('booking messages get an acknowledgement and an approval entry, never a price', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'Bhai booking confirm karo 10 ton PA' });
  advance(clock, 5_000);
  await engine.processQueue();
  assert.match(transport.sent[0].text, /Booking request noted/);
  assert.doesNotMatch(transport.sent[0].text, /₹/);
  const a = db.prepare('SELECT * FROM approvals').get() as any;
  assert.equal(a.quantity_kg, 10000);
  assert.equal(a.status, 'new');
});

test('the bot never answers its own quotes', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  setSetting(db, 'test_group_jid', BROKERS);
  transport.inject({ chatId: BROKERS, text: 'pa rate?' });
  advance(clock, 5_000);
  await engine.processQueue();
  const sent = transport.sent[0];
  const r = engine.handleIncoming({ id: sent.id, chatId: BROKERS, sender: 'me', fromMe: true, text: sent.text, timestamp: clock.t });
  assert.equal(r.outcome, 'ignored');
});

test('a reply interrupted mid-send is marked failed on restart, not resent', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pa rate?' });
  db.prepare("UPDATE replies SET status = 'sending'").run();
  const engine2 = new Engine(db, transport);
  engine2.start(60_000);
  engine2.stop();
  assert.equal(replies(db)[0].status, 'failed');
  assert.equal(transport.sent.length, 0);
});

test('a scheduled reply survives a restart and is sent exactly once', async () => {
  const { db, clock, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: 'pa rate?' });
  const engine2 = new Engine(db, transport, () => clock.t);
  advance(clock, 5_000);
  await Promise.all([engine2.processQueue(), engine.processQueue()]);
  await engine2.processQueue();
  assert.equal(transport.sent.length, 1);
});

test('a requested brand we do not stock is said so, with stocked options', async () => {
  const { db, transport, engine } = setup();
  await ready(db, transport, engine);
  transport.inject({ chatId: BROKERS, text: '10 ton Msg 30 / 40 mesh Imm payment Price pls *Fufeng first priority' });
  const body = replies(db)[0].body;
  assert.match(body, /Fufeng is not available/);
  assert.match(body, /Meihua/);
  assert.match(body, /10 tons/);
  assert.ok(getSettings(db));
});
