import { mkdirSync } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir,
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'bot.sqlite'),
  waAuthDir: path.join(dataDir, 'wa-auth'),
  /** "baileys" links a real WhatsApp number; "mock" sends nowhere and is for local testing. */
  transport: (process.env.WA_TRANSPORT ?? 'baileys') as 'baileys' | 'mock',
  production: process.env.NODE_ENV === 'production',
  sessionHours: 12,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
};
