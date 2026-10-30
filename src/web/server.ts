import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Engine } from '../bot/engine.ts';
import type { DB } from '../db/index.ts';
import { apiRouter } from './api.ts';
import { COOKIE, cookieOptions, loadUser, login, logout, requireCsrfHeader, requireLogin, sessionToken } from './auth.ts';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
}

export function createApp(db: DB, engine: Engine) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(loadUser(db));

  // ----- public: only the login page and its assets. No names, numbers or data. -----
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.sendFile(path.join(publicDir, 'login.html'))));
  app.get(['/login.js', '/style.css'], (req, res) => res.sendFile(path.join(publicDir, req.path)));
  app.post('/api/login', requireCsrfHeader, async (req, res) => {
    const result = await login(db, String(req.body?.email ?? ''), String(req.body?.password ?? ''), req.ip ?? 'unknown');
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.cookie(COOKIE, result.token, cookieOptions());
    res.json({ user: result.user });
  });

  // ----- everything below needs a valid session, checked on the server -----
  app.use(requireLogin);
  app.use(requireCsrfHeader);
  app.post('/api/logout', (req, res) => {
    logout(db, sessionToken(req));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  app.use('/api', apiRouter(db, engine));
  app.get('/', (_req, res) => res.redirect('/app/'));
  app.use('/app', express.static(path.join(publicDir, 'app'), { index: 'index.html' }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}
