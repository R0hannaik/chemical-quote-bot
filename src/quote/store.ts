import { audit, tx, type Actor, type DB } from '../db/index.ts';
import type { Templates } from './build.ts';
import { DEFAULT_TEMPLATES, TEMPLATE_MODES, type TemplateMode } from './templates.ts';

/** Active templates plus the version number that identifies this set (the highest active version). */
export function loadTemplates(db: DB): Templates {
  const rows = db.prepare('SELECT mode, body, version FROM templates WHERE active = 1').all() as
    { mode: TemplateMode; body: string; version: number }[];
  const t = { ...DEFAULT_TEMPLATES, version: 1 } as unknown as Templates;
  for (const r of rows) {
    (t as any)[r.mode] = r.body;
    t.version = Math.max(t.version, r.version);
  }
  return t;
}

/** Saving creates a new version; older versions stay for history and restore. */
export function saveTemplate(db: DB, mode: TemplateMode, body: string, actor: Actor): number {
  if (!TEMPLATE_MODES.includes(mode)) throw new Error(`Unknown template "${mode}"`);
  return tx(db, () => {
    const before = db.prepare('SELECT body FROM templates WHERE mode = ? AND active = 1').get(mode) as { body: string } | undefined;
    const { v } = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM templates').get() as { v: number };
    db.prepare('UPDATE templates SET active = 0 WHERE mode = ?').run(mode);
    db.prepare('INSERT INTO templates(mode, body, version, active, created_by) VALUES(?,?,?,1,?)').run(mode, body, v, actor.name);
    audit(db, actor, 'template.save', `template:${mode}`, before?.body, body);
    return v;
  });
}

export function templateHistory(db: DB, mode: TemplateMode) {
  return db.prepare('SELECT id, version, body, active, created_by, created_at FROM templates WHERE mode = ? ORDER BY version DESC LIMIT 30')
    .all(mode);
}

export function restoreTemplate(db: DB, id: number, actor: Actor): number {
  const row = db.prepare('SELECT mode, body FROM templates WHERE id = ?').get(id) as { mode: TemplateMode; body: string } | undefined;
  if (!row) throw new Error('Version not found');
  return saveTemplate(db, row.mode, row.body, actor);
}
