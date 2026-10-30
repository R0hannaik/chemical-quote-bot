import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.ts';
import type { DB } from '../db/index.ts';

export type Role = 'owner' | 'operator' | 'viewer';
export interface User { id: number; name: string; email: string; role: Role }

declare module 'express-serve-static-core' {
  interface Request { user?: User }
}

export const COOKIE = 'pq_session';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const hashPassword = (pw: string) => hash(pw); // Argon2id with library defaults

export async function createUser(db: DB, name: string, email: string, role: Role, password: string) {
  if (password.length < 10) throw new Error('Password must be at least 10 characters');
  const r = db.prepare('INSERT INTO users(name, email, role, password_hash) VALUES(?,?,?,?)')
    .run(name, email.trim(), role, await hashPassword(password));
  return Number(r.lastInsertRowid);
}

// ---------- login attempt limiting: 5 per 15 minutes per account and per IP ----------

const WINDOW = 15 * 60_000;
const attempts = new Map<string, number[]>();
function tooMany(key: string, now: number) {
  const list = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW);
  attempts.set(key, list);
  return list.length >= 5;
}
function recordFailure(key: string, now: number) { attempts.set(key, [...(attempts.get(key) ?? []), now]); }

export async function login(db: DB, email: string, password: string, ip: string): Promise<{ token: string; user: User } | { error: string; status: number }> {
  const now = Date.now();
  const kEmail = `e:${email.toLowerCase()}`, kIp = `i:${ip}`;
  if (tooMany(kEmail, now) || tooMany(kIp, now)) return { error: 'Too many attempts. Try again in 15 minutes.', status: 429 };
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as any;
  // Verify against a dummy hash when the user does not exist, so timing does not reveal valid emails.
  const ok = row ? await verify(row.password_hash, password).catch(() => false) : (await verify(DUMMY, password).catch(() => false), false);
  if (!ok) {
    recordFailure(kEmail, now); recordFailure(kIp, now);
    return { error: 'Wrong email or password', status: 401 };
  }
  attempts.delete(kEmail);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now + config.sessionHours * 3_600_000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(sha256(token), row.id, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
  return { token, user: { id: row.id, name: row.name, email: row.email, role: row.role } };
}
const DUMMY = await hash('not-a-real-password-placeholder');

export function logout(db: DB, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function logoutEverywhere(db: DB, userId: number) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: config.production, maxAge: config.sessionHours * 3_600_000, path: '/' };
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionToken(req: Request) { return readCookie(req, COOKIE); }

/** Attaches req.user from the session cookie. Checked on the server for every request. */
export function loadUser(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      const row = db.prepare(`SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), new Date().toISOString()) as unknown as User | undefined;
      if (row) req.user = row;
    }
    next();
  };
}

/** Page routes: redirect to login. API routes: 401. Nothing else is sent. */
export function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  return res.redirect(302, '/login');
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 };
export function requireRole(min: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user && RANK[req.user.role] >= RANK[min]) return next();
    return res.status(403).json({ error: `Needs ${min} access` });
  };
}

/**
 * Cheap CSRF guard: state-changing API calls must carry a custom header, which a browser
 * will not add to a cross-site request without a CORS preflight we never approve.
 */
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') === 'pq-dashboard') return next();
  return res.status(403).json({ error: 'Missing request header' });
}
