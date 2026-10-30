import { Router, type Request, type Response, type NextFunction } from 'express';
import QRCode from 'qrcode';
import type { Engine } from '../bot/engine.ts';
import { MockTransport } from '../bot/mock.ts';
import { findAliasClash, loadProducts, ORIGINS, STOCK_STATUSES, type Product } from '../catalog/catalog.ts';
import { audit, getSettings, setSetting, tx, DEFAULT_SETTINGS, type Actor, type DB, type Settings } from '../db/index.ts';
import { normaliseTerm } from '../parser/normalise.ts';
import { parseInquiry } from '../parser/parser.ts';
import { buildReply, rowProblem } from '../quote/build.ts';
import { loadTemplates, restoreTemplate, saveTemplate, templateHistory } from '../quote/store.ts';
import { TEMPLATE_MODES, TEMPLATE_VARIABLES, type TemplateMode } from '../quote/templates.ts';
import { createUser, logoutEverywhere, hashPassword, requireRole, type Role } from './auth.ts';
import { csvCell, parseCsv, validateProduct, ValidationError } from './validate.ts';

const actor = (req: Request): Actor => ({ id: req.user!.id, name: req.user!.name });
type H = (req: Request, res: Response) => unknown | Promise<unknown>;
/** Wraps a handler so thrown errors become JSON responses. */
const h = (fn: H) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    const status = (e as any).status ?? (e instanceof ValidationError ? 400 : 400);
    res.status(status).json({ error: (e as Error).message });
  }
};
const num = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n)) throw new ValidationError('Bad id'); return n; };

export function apiRouter(db: DB, engine: Engine) {
  const r = Router();
  const OP = requireRole('operator'), OWNER = requireRole('owner');

  // ---------- session + meta ----------

  r.get('/me', h((req) => req.user));
  r.get('/meta', h(() => ({ origins: ORIGINS, statuses: STOCK_STATUSES, templateModes: TEMPLATE_MODES, templateVariables: TEMPLATE_VARIABLES,
    transport: engine.transport.kind })));

  r.get('/status', h(async () => {
    const st = engine.transport.status();
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const s = getSettings(db);
    return {
      whatsapp: { state: st.state, since: st.since, me: st.me ?? null, qr: st.qr ? await QRCode.toDataURL(st.qr, { margin: 1, width: 260 }) : null },
      counts: {
        groups: count('SELECT COUNT(*) n FROM groups'),
        activeGroups: count('SELECT COUNT(*) n FROM groups WHERE auto_reply = 1'),
        products: count('SELECT COUNT(*) n FROM products WHERE active = 1'),
        held: count("SELECT COUNT(*) n FROM replies WHERE status IN ('held','failed')"),
        approvals: count("SELECT COUNT(*) n FROM approvals WHERE status = 'new'"),
        unmatched: count("SELECT COUNT(*) n FROM messages WHERE outcome = 'unmatched'"),
        stalePrices: loadProducts(db).flatMap((p) => p.rows).filter((row) => rowProblem(row, new Date())).length,
      },
      killSwitch: s.kill_switch,
      delaySeconds: s.delay_seconds,
      testGroup: s.test_group_jid,
      alerts: db.prepare('SELECT * FROM alerts WHERE seen = 0 ORDER BY id DESC LIMIT 20').all(),
    };
  }));
  r.post('/alerts/seen', OP, h(() => { db.prepare('UPDATE alerts SET seen = 1').run(); return { ok: true }; }));

  // ---------- WhatsApp connection ----------

  r.post('/wa/logout', OWNER, h(async (req) => { await engine.transport.logout(); audit(db, actor(req), 'whatsapp.unlink', 'whatsapp'); return { ok: true }; }));
  r.post('/wa/sync', OP, h(async (req) => {
    if (engine.transport.status().state !== 'open') throw new ValidationError('WhatsApp is not connected');
    return { count: await engine.syncGroups(actor(req)) };
  }));

  r.post('/kill-switch', OP, h((req) => {
    const on = !!req.body?.on;
    if (!on && req.user!.role !== 'owner') throw Object.assign(new Error('Only the owner can turn sending back on'), { status: 403 });
    setSetting(db, 'kill_switch', on);
    audit(db, actor(req), on ? 'kill_switch.on' : 'kill_switch.off', 'settings');
    return { killSwitch: on };
  }));

  // ---------- products and prices ----------

  r.get('/products', h(() => {
    const now = new Date();
    return loadProducts(db, true).map((p) => ({ ...p, rows: p.rows.map((row) => ({ ...row, problem: rowProblem(row, now) })) }));
  }));

  const saveProduct = (input: ReturnType<typeof validateProduct>, existing: Product | null, who: Actor) => tx(db, () => {
    let id = existing?.id;
    const now = new Date().toISOString();
    if (existing) {
      db.prepare('UPDATE products SET name=?, aliases=?, pack_size_kg=?, packaging=?, location=?, gst_pct=? WHERE id=?')
        .run(input.name, JSON.stringify(input.aliases), input.pack_size_kg, input.packaging, input.location, input.gst_pct, existing.id);
    } else {
      id = Number(db.prepare('INSERT INTO products(name, aliases, pack_size_kg, packaging, location, gst_pct) VALUES(?,?,?,?,?,?)')
        .run(input.name, JSON.stringify(input.aliases), input.pack_size_kg, input.packaging, input.location, input.gst_pct).lastInsertRowid);
    }
    const keep = new Set<number>();
    for (const row of input.rows) {
      const old = existing?.rows.find((x) => x.id === row.id);
      if (old) {
        const changed = old.rate !== row.rate || old.status !== row.status;
        db.prepare('UPDATE price_rows SET origin=?, brand=?, rate=?, status=?, freshness_hours=?, updated_at=?, updated_by=? WHERE id=?')
          .run(row.origin, row.brand, row.rate, row.status, row.freshness_hours, changed ? now : old.updated_at,
            changed ? who.name : old.updated_by, old.id);
        keep.add(old.id);
      } else {
        const rid = db.prepare('INSERT INTO price_rows(product_id, origin, brand, rate, status, freshness_hours, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?)')
          .run(id!, row.origin, row.brand, row.rate, row.status, row.freshness_hours, now, who.name).lastInsertRowid;
        keep.add(Number(rid));
      }
    }
    for (const old of existing?.rows ?? []) if (!keep.has(old.id)) db.prepare('DELETE FROM price_rows WHERE id = ?').run(old.id);
    audit(db, who, existing ? 'product.update' : 'product.create', `product:${id}`, existing ?? undefined, input);
    return id!;
  });

  r.post('/products', OP, h((req) => {
    const all = loadProducts(db, true);
    return { id: saveProduct(validateProduct(req.body, all), null, actor(req)) };
  }));
  r.put('/products/:id', OP, h((req) => {
    const all = loadProducts(db, true);
    const existing = all.find((p) => p.id === num(req.params.id));
    if (!existing) throw new ValidationError('Not found');
    return { id: saveProduct(validateProduct(req.body, all, existing.id), existing, actor(req)) };
  }));
  r.post('/products/:id/active', OP, h((req) => {
    const id = num(req.params.id), on = !!req.body?.active;
    db.prepare('UPDATE products SET active = ? WHERE id = ?').run(on ? 1 : 0, id);
    audit(db, actor(req), on ? 'product.activate' : 'product.deactivate', `product:${id}`);
    return { ok: true };
  }));
  r.post('/prices/confirm', OP, h((req) => {
    const ids: number[] | undefined = Array.isArray(req.body?.productIds) ? req.body.productIds.map(num) : undefined;
    const now = new Date().toISOString();
    const sql = `UPDATE price_rows SET updated_at = ?, updated_by = ? WHERE rate > 0 ${ids ? `AND product_id IN (${ids.map(() => '?').join(',')})` : ''}`;
    const res = db.prepare(sql).run(now, req.user!.name, ...(ids ?? []));
    audit(db, actor(req), 'prices.confirm', ids ? `products:${ids.join(',')}` : 'products:all', undefined, { rows: res.changes });
    return { confirmed: res.changes };
  }));

  r.get('/products.csv', h((_req, res) => {
    const lines = [['product', 'aliases', 'origin', 'brand', 'rate', 'status', 'freshness_hours', 'packaging', 'pack_size_kg', 'location', 'gst_pct']];
    for (const p of loadProducts(db)) {
      const rows = p.rows.length ? p.rows : [null];
      for (const row of rows) lines.push([p.name, p.aliases.join('; '), row?.origin ?? '', row?.brand ?? '', String(row?.rate ?? ''),
        row?.status ?? '', String(row?.freshness_hours ?? ''), p.packaging, String(p.pack_size_kg ?? ''), p.location, String(p.gst_pct)]);
    }
    res.type('text/csv').attachment('rates.csv').send(lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n');
  }));

  r.post('/products/import', OP, h((req) => {
    const rows = parseCsv(String(req.body?.csv ?? ''));
    const head = rows.shift()?.map((c) => c.trim().toLowerCase()) ?? [];
    const col = (name: string) => head.indexOf(name);
    if (col('product') < 0 || col('rate') < 0 || col('origin') < 0) throw new ValidationError('CSV needs product, origin and rate columns');
    const byName = new Map<string, any>();
    for (const cells of rows) {
      const get = (n: string) => (col(n) >= 0 ? cells[col(n)]?.trim() ?? '' : '');
      const name = get('product');
      if (!name) continue;
      const p = byName.get(name.toLowerCase()) ?? { name, aliases: get('aliases').split(/[;,]/), packaging: get('packaging'),
        pack_size_kg: get('pack_size_kg'), location: get('location'), gst_pct: get('gst_pct'), rows: [] };
      if (get('rate')) p.rows.push({ origin: get('origin'), brand: get('brand'), rate: get('rate'), status: get('status') || 'In Stock',
        freshness_hours: get('freshness_hours') || 24 });
      byName.set(name.toLowerCase(), p);
    }
    let created = 0, updated = 0;
    const errors: string[] = [];
    for (const body of byName.values()) {
      try {
        const all = loadProducts(db, true);
        const existing = all.find((p) => p.name.toLowerCase() === body.name.toLowerCase()) ?? null;
        if (existing) body.rows = body.rows.map((row: any) => ({ ...row, id: existing.rows.find((x) => x.origin === row.origin && x.brand === row.brand)?.id }));
        saveProduct(validateProduct(body, all, existing?.id), existing, actor(req));
        existing ? updated++ : created++;
      } catch (e) { errors.push(`${body.name}: ${(e as Error).message}`); }
    }
    return { created, updated, errors };
  }));

  r.post('/aliases', OP, h((req) => {
    const id = num(req.body?.productId);
    const alias = String(req.body?.alias ?? '').trim();
    if (!normaliseTerm(alias)) throw new ValidationError('Alias is empty');
    const all = loadProducts(db, true);
    const p = all.find((x) => x.id === id);
    if (!p) throw new ValidationError('Product not found');
    const clash = findAliasClash(all, [alias], p.id);
    if (clash) throw new ValidationError(`"${alias}" is already a name for ${clash.product}`);
    if (p.aliases.some((a) => normaliseTerm(a) === normaliseTerm(alias))) throw new ValidationError(`${p.name} already has that name`);
    db.prepare('UPDATE products SET aliases = ? WHERE id = ?').run(JSON.stringify([...p.aliases, alias]), p.id);
    audit(db, actor(req), 'product.alias_add', `product:${p.id}`, p.aliases, [...p.aliases, alias]);
    return { ok: true };
  }));

  // ---------- groups ----------

  r.get('/groups', h((req) => {
    const q = `%${String(req.query.q ?? '').toLowerCase()}%`;
    const s = getSettings(db);
    return (db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM replies r WHERE r.group_id = g.id AND r.status = 'sent') AS quotes_sent
      FROM groups g WHERE LOWER(g.name) LIKE ? ORDER BY g.auto_reply DESC, g.name`).all(q) as any[])
      .map((g) => ({ ...g, auto_reply: !!g.auto_reply, is_test: g.wa_jid === s.test_group_jid }));
  }));
  r.put('/groups/:id', OP, h((req) => {
    const id = num(req.params.id);
    const before = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    if (!before) throw new ValidationError('Not found');
    if (req.body?.auto_reply !== undefined) db.prepare('UPDATE groups SET auto_reply = ? WHERE id = ?').run(req.body.auto_reply ? 1 : 0, id);
    if (req.body?.category && ['broker', 'internal', 'test', 'vip'].includes(req.body.category))
      db.prepare('UPDATE groups SET category = ? WHERE id = ?').run(req.body.category, id);
    audit(db, actor(req), 'group.update', `group:${id}`, before, req.body);
    return { ok: true };
  }));
  r.post('/groups/all-off', OP, h((req) => {
    const res = db.prepare('UPDATE groups SET auto_reply = 0 WHERE auto_reply = 1').run();
    audit(db, actor(req), 'groups.all_off', 'groups', undefined, { changed: res.changes });
    return { changed: res.changes };
  }));
  r.post('/groups/:id/test', OWNER, h((req) => {
    const g = db.prepare('SELECT wa_jid FROM groups WHERE id = ?').get(num(req.params.id)) as { wa_jid: string } | undefined;
    if (!g) throw new ValidationError('Not found');
    setSetting(db, 'test_group_jid', g.wa_jid);
    audit(db, actor(req), 'settings.test_group', 'settings', undefined, g.wa_jid);
    return { ok: true };
  }));

  // ---------- live stream, replies ----------

  r.get('/stream', h((req) => {
    const limit = Math.min(200, Number(req.query.limit ?? 60));
    const outcome = String(req.query.outcome ?? '');
    const rows = db.prepare(`SELECT m.id, m.text, m.sender, m.sender_name, m.received_at, m.intent, m.confidence, m.outcome, m.parse_json,
        g.name AS group_name,
        r.id AS reply_id, r.status AS reply_status, r.reason AS reply_reason, r.body AS reply_body, r.kind AS reply_kind, r.sent_at
      FROM messages m JOIN groups g ON g.id = m.group_id
      LEFT JOIN replies r ON r.id = (SELECT MAX(id) FROM replies WHERE message_id = m.id)
      ${outcome ? 'WHERE m.outcome = ?' : ''} ORDER BY m.id DESC LIMIT ?`).all(...(outcome ? [outcome, limit] : [limit])) as any[];
    return rows.map(({ parse_json, ...row }) => {
      const p = parse_json ? JSON.parse(parse_json) : null;
      return { ...row, items: p?.items ?? [], reasons: p?.reasons ?? [] };
    });
  }));
  r.post('/replies/:id/resend', OP, h((req) => engine.resend(num(req.params.id), actor(req))));
  r.post('/replies/:id/cancel', OP, h((req) => { engine.cancel(num(req.params.id), actor(req)); return { ok: true }; }));

  // ---------- approvals ----------

  r.get('/approvals', h(() => db.prepare(`SELECT a.*, p.name AS product_name, m.text, m.sender, m.sender_name, m.received_at, g.name AS group_name
    FROM approvals a JOIN messages m ON m.id = a.message_id JOIN groups g ON g.id = m.group_id LEFT JOIN products p ON p.id = a.product_id
    ORDER BY CASE a.status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END, a.id DESC LIMIT 200`).all()));
  r.put('/approvals/:id', OP, h((req) => {
    const id = num(req.params.id);
    const status = String(req.body?.status ?? '');
    if (!['new', 'contacted', 'won', 'lost'].includes(status)) throw new ValidationError('Bad status');
    db.prepare('UPDATE approvals SET status = ?, assignee = COALESCE(?, assignee), updated_at = ? WHERE id = ?')
      .run(status, req.body?.assignee ?? null, new Date().toISOString(), id);
    audit(db, actor(req), 'approval.update', `approval:${id}`, undefined, req.body);
    return { ok: true };
  }));

  // ---------- unmatched ----------

  r.get('/unmatched', h(() => (db.prepare(`SELECT m.id, m.text, m.received_at, m.parse_json, g.name AS group_name FROM messages m
      JOIN groups g ON g.id = m.group_id WHERE m.outcome = 'unmatched' ORDER BY m.id DESC LIMIT 200`).all() as any[])
    .map(({ parse_json, ...row }) => ({ ...row, nearMisses: parse_json ? JSON.parse(parse_json).nearMisses : [] }))));
  r.post('/unmatched/:id/dismiss', OP, h((req) => {
    db.prepare("UPDATE messages SET outcome = 'ignored' WHERE id = ? AND outcome = 'unmatched'").run(num(req.params.id));
    return { ok: true };
  }));

  // ---------- simulator (never sends) ----------

  r.post('/simulate', h((req) => {
    const text = String(req.body?.text ?? '').slice(0, 2000);
    const catalog = engine.catalog();
    const parse = parseInquiry(text, catalog);
    const built = buildReply(parse, catalog, getSettings(db), loadTemplates(db));
    return { parse, built };
  }));
  r.post('/dev/inject', OP, h((req) => {
    if (!(engine.transport instanceof MockTransport)) throw Object.assign(new Error('Only available with the mock transport'), { status: 404 });
    const s = getSettings(db);
    const chatId = String(req.body?.chatId || s.test_group_jid || 'test-group@g.us');
    const m = engine.transport.inject({ chatId, text: String(req.body?.text ?? ''), senderName: req.body?.senderName || 'Test Broker',
      sender: req.body?.sender || '919800000001@s.whatsapp.net' });
    return { id: m.id };
  }));
  r.get('/dev/sent', h(() => (engine.transport instanceof MockTransport ? engine.transport.sent.slice(-50).reverse() : [])));

  // ---------- templates ----------

  r.get('/templates', h(() => loadTemplates(db)));
  r.put('/templates/:mode', OP, h((req) => {
    const body = String(req.body?.body ?? '');
    if (!body.trim()) throw new ValidationError('Template is empty');
    return { version: saveTemplate(db, req.params.mode as TemplateMode, body, actor(req)) };
  }));
  r.get('/templates/:mode/history', h((req) => templateHistory(db, req.params.mode as TemplateMode)));
  r.post('/templates/restore/:id', OP, h((req) => ({ version: restoreTemplate(db, num(req.params.id), actor(req)) })));
  r.post('/templates/preview', h((req) => {
    const t = { ...loadTemplates(db) };
    for (const mode of TEMPLATE_MODES) if (typeof req.body?.templates?.[mode] === 'string') (t as any)[mode] = req.body.templates[mode];
    const catalog = engine.catalog();
    const parse = parseInquiry(String(req.body?.text ?? ''), catalog);
    // Preview with prices treated as fresh, so the operator sees the layout even when prices need confirming.
    const fresh = { ...catalog, products: new Map([...catalog.products].map(([id, p]) =>
      [id, { ...p, rows: p.rows.map((row) => ({ ...row, updated_at: new Date().toISOString() })) }])) };
    return buildReply(parse, fresh, getSettings(db), t);
  }));

  // ---------- settings, users, audit ----------

  r.get('/settings', h(() => getSettings(db)));
  r.put('/settings', OWNER, h((req) => {
    const b = req.body ?? {};
    const before = getSettings(db);
    const next: Partial<Settings> = {};
    if (b.business_name !== undefined) next.business_name = String(b.business_name).trim().slice(0, 80) || DEFAULT_SETTINGS.business_name;
    if (b.contact_name !== undefined) next.contact_name = String(b.contact_name).trim().slice(0, 80);
    if (b.contact_phone !== undefined) next.contact_phone = String(b.contact_phone).trim().slice(0, 30);
    if (b.delay_seconds !== undefined) {
      const d = Number(b.delay_seconds);
      if (!(d >= 0 && d <= 60)) throw new ValidationError('Delay must be 0–60 seconds');
      next.delay_seconds = Math.round(d);
    }
    if (b.typing_on !== undefined) next.typing_on = !!b.typing_on;
    if (b.business_hours) {
      const bh = b.business_hours, re = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!re.test(bh.start) || !re.test(bh.end) || bh.start >= bh.end) throw new ValidationError('Business hours need HH:MM start before end');
      next.business_hours = { enabled: !!bh.enabled, start: bh.start, end: bh.end, tz: before.business_hours.tz };
    }
    if (b.rate_limits) {
      const rl = b.rate_limits;
      const vals = [rl.per_group_seconds, rl.per_group_hour, rl.global_hour].map(Number);
      if (vals.some((v) => !(v >= 0 && v <= 10_000))) throw new ValidationError('Rate limits must be 0–10000');
      next.rate_limits = { per_group_seconds: vals[0], per_group_hour: vals[1], global_hour: vals[2] };
    }
    if (Array.isArray(b.known_brands)) next.known_brands = b.known_brands.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean);
    if (b.duplicate_window_minutes !== undefined) next.duplicate_window_minutes = Math.max(0, Math.min(1440, Number(b.duplicate_window_minutes) || 0));
    for (const [k, v] of Object.entries(next)) setSetting(db, k as keyof Settings, v as never);
    audit(db, actor(req), 'settings.update', 'settings', before, next);
    return getSettings(db);
  }));

  r.get('/users', OWNER, h(() => db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY id').all()));
  r.post('/users', OWNER, h(async (req) => {
    const role = String(req.body?.role) as Role;
    if (!['owner', 'operator', 'viewer'].includes(role)) throw new ValidationError('Bad role');
    const name = String(req.body?.name ?? '').trim(), email = String(req.body?.email ?? '').trim();
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new ValidationError('Name and a valid email are required');
    const id = await createUser(db, name, email, role, String(req.body?.password ?? ''));
    audit(db, actor(req), 'user.create', `user:${id}`, undefined, { name, email, role });
    return { id };
  }));
  r.delete('/users/:id', OWNER, h((req) => {
    const id = num(req.params.id);
    if (id === req.user!.id) throw new ValidationError('You cannot remove yourself');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(db, actor(req), 'user.delete', `user:${id}`);
    return { ok: true };
  }));
  r.post('/me/password', h(async (req) => {
    const pw = String(req.body?.password ?? '');
    if (pw.length < 10) throw new ValidationError('Password must be at least 10 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(pw), req.user!.id);
    logoutEverywhere(db, req.user!.id);
    audit(db, actor(req), 'user.password', `user:${req.user!.id}`);
    return { ok: true };
  }));
  r.get('/audit', OWNER, h(() => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all()));

  // ---------- reports ----------

  r.get('/reports', h(() => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const msgs = db.prepare('SELECT received_at, parse_json, outcome FROM messages WHERE received_at > ?').all(since) as any[];
    const perProduct = new Map<string, number>();
    const perDay = new Map<string, number>();
    for (const m of msgs) {
      const day = m.received_at.slice(0, 10);
      if (m.outcome && m.outcome !== 'ignored') perDay.set(day, (perDay.get(day) ?? 0) + 1);
      for (const it of m.parse_json ? JSON.parse(m.parse_json).items : []) perProduct.set(it.productName, (perProduct.get(it.productName) ?? 0) + 1);
    }
    const inquiries = msgs.filter((m) => m.outcome && m.outcome !== 'ignored').length;
    const unmatched = msgs.filter((m) => m.outcome === 'unmatched').length;
    return {
      inquiries,
      unmatchedRate: inquiries ? unmatched / inquiries : 0,
      perDay: [...perDay].sort().map(([day, n]) => ({ day, n })),
      perProduct: [...perProduct].sort((a, b) => b[1] - a[1]).map(([product, n]) => ({ product, n })),
      perGroup: db.prepare(`SELECT g.name, COUNT(*) AS n FROM replies r JOIN groups g ON g.id = r.group_id
        WHERE r.status = 'sent' AND r.created_at > ? GROUP BY g.id ORDER BY n DESC`).all(since),
      approvals: db.prepare('SELECT status, COUNT(*) AS n FROM approvals GROUP BY status').all(),
      replies: db.prepare('SELECT status, COUNT(*) AS n FROM replies WHERE created_at > ? GROUP BY status').all(since),
    };
  }));

  return r;
}
