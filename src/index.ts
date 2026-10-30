import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { BaileysTransport } from './bot/baileys.ts';
import { Engine } from './bot/engine.ts';
import { MockTransport } from './bot/mock.ts';
import type { Transport } from './bot/transport.ts';
import { config } from './config.ts';
import { alert, openDb } from './db/index.ts';
import { createUser } from './web/auth.ts';
import { createApp } from './web/server.ts';

const log = pino({ name: 'app' });
const db = openDb(config.dbPath);

// First run: create the owner account.
const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
if (n === 0) {
  const email = config.adminEmail ?? 'owner@example.com';
  const password = config.adminPassword ?? randomBytes(9).toString('base64url');
  await createUser(db, 'Owner', email, 'owner', password);
  log.warn(config.adminPassword
    ? `Created owner account ${email}`
    : `Created owner account ${email} with password ${password} — log in and change it under Settings.`);
}

const transport: Transport = config.transport === 'mock' ? new MockTransport() : new BaileysTransport(config.waAuthDir);
const engine = new Engine(db, transport);

// Alert when WhatsApp stays disconnected for more than 2 minutes.
let downTimer: NodeJS.Timeout | null = null;
transport.onStatus((s) => {
  if (s.state === 'open') { if (downTimer) clearTimeout(downTimer); downTimer = null; return; }
  if (!downTimer && s.state !== 'qr') downTimer = setTimeout(() => alert(db, 'critical', 'WhatsApp has been disconnected for over 2 minutes'), 120_000);
});

engine.start();
await transport.start();

const app = createApp(db, engine);
app.listen(config.port, () => log.info(`Dashboard on http://localhost:${config.port} (WhatsApp transport: ${transport.kind})`));

const shutdown = async () => { engine.stop(); await transport.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
