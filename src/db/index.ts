import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema.ts';
import { seedIfEmpty } from './seed.ts';

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  seedIfEmpty(db);
  return db;
}

export const nowIso = () => new Date().toISOString();

// ---------- settings ----------

export interface Settings {
  business_name: string;
  contact_name: string;
  contact_phone: string;
  delay_seconds: number;
  typing_on: boolean;
  business_hours: { enabled: boolean; start: string; end: string; tz: string };
  rate_limits: { per_group_seconds: number; per_group_hour: number; global_hour: number };
  kill_switch: boolean;
  test_group_jid: string | null;
  known_brands: string[];
  duplicate_window_minutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  business_name: 'Pawan Chemicals',
  contact_name: 'Pratham Kedia',
  contact_phone: '',
  delay_seconds: 3,
  typing_on: true,
  business_hours: { enabled: true, start: '09:00', end: '21:00', tz: 'Asia/Kolkata' },
  rate_limits: { per_group_seconds: 20, per_group_hour: 30, global_hour: 200 },
  kill_switch: false,
  test_group_jid: null,
  // Brand names brokers ask for. Used to spot a request for a brand the firm does not stock.
  known_brands: ['fufeng', 'meihua', 'ajinomoto', 'eppen', 'wells', 'hi tech', 'lg chem', 'formosa',
    'nippon shokubai', 'satellite', 'boeko', 'tengda', 'mci', 'ineos', 'reliance', 'igpl', 'aekyung',
    'jiuan', 'mitsubishi', 'shuntian', 'wuhan', 'dadi', 'shandong haili', 'bcc', 'impera', 'ensign',
    'weifang', 'lotte', 'sabic', 'basf', 'dow', 'gacl', 'dcm', 'national peroxide', 'perstorp'],
  duplicate_window_minutes: 10,
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = JSON.parse(r.value);
  return s as unknown as Settings;
}

export function setSetting<K extends keyof Settings>(db: DB, key: K, value: Settings[K]) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- audit + alerts ----------

export interface Actor { id: number | null; name: string }
export const SYSTEM: Actor = { id: null, name: 'system' };

export function audit(db: DB, actor: Actor, action: string, entity: string, before?: unknown, after?: unknown) {
  db.prepare('INSERT INTO audit_log(user_id, user_name, action, entity, before_json, after_json) VALUES(?,?,?,?,?,?)')
    .run(actor.id, actor.name, action, entity,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after));
}

export function alert(db: DB, level: 'info' | 'warn' | 'critical', text: string) {
  db.prepare('INSERT INTO alerts(level, text) VALUES(?, ?)').run(level, text);
}

/** Runs fn inside a transaction. node:sqlite has no helper for this. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
