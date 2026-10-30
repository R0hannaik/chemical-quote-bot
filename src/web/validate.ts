import { findAliasClash, ORIGINS, STOCK_STATUSES, type Product } from '../catalog/catalog.ts';
import { normaliseTerm } from '../parser/normalise.ts';

export interface ProductInput {
  name: string; aliases: string[]; pack_size_kg: number | null; packaging: string; location: string; gst_pct: number;
  rows: { id?: number; origin: string; brand: string; rate: number; status: string; freshness_hours: number }[];
}

export class ValidationError extends Error { status = 400; }

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Checks a product edit. Refuses zero or blank prices, unknown origins and aliases used by another product. */
export function validateProduct(body: any, all: Product[], excludeId?: number): ProductInput {
  const name = str(body?.name);
  if (!name) throw new ValidationError('Chemical name is required');
  const aliases = [...new Set((Array.isArray(body.aliases) ? body.aliases : String(body.aliases ?? '').split(','))
    .map((a: unknown) => str(a, 60)).filter((a: string) => normaliseTerm(a)))] as string[];
  if (!aliases.length) throw new ValidationError('Add at least one common name or abbreviation');
  const clash = findAliasClash(all, aliases, excludeId);
  if (clash) throw new ValidationError(`"${clash.alias}" is already a name for ${clash.product}`);

  const rowsIn = Array.isArray(body.rows) ? body.rows : [];
  const rows = rowsIn.map((r: any, i: number) => {
    const origin = str(r.origin);
    if (!(ORIGINS as readonly string[]).includes(origin)) throw new ValidationError(`Row ${i + 1}: choose an origin from the list`);
    const rate = Number(r.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new ValidationError(`Row ${i + 1} (${origin}): enter a price above zero`);
    const status = str(r.status) || 'In Stock';
    if (!(STOCK_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Row ${i + 1}: unknown stock status`);
    const freshness = Math.round(Number(r.freshness_hours ?? 24));
    if (!(freshness >= 1 && freshness <= 24 * 30)) throw new ValidationError(`Row ${i + 1}: freshness must be 1–720 hours`);
    return { id: r.id ? Number(r.id) : undefined, origin, brand: str(r.brand, 60), rate: Math.round(rate * 100) / 100, status, freshness_hours: freshness };
  });
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.origin}|${r.brand.toLowerCase()}`;
    if (seen.has(k)) throw new ValidationError(`Two rows for ${r.origin}${r.brand ? ` / ${r.brand}` : ''}`);
    seen.add(k);
  }

  const pack = body.pack_size_kg === '' || body.pack_size_kg == null ? null : Number(body.pack_size_kg);
  if (pack !== null && !(pack > 0)) throw new ValidationError('Pack size must be a positive number of kg');
  const gst = body.gst_pct == null || body.gst_pct === '' ? 18 : Number(body.gst_pct);
  if (!(gst >= 0 && gst <= 28)) throw new ValidationError('GST must be between 0 and 28%');

  return { name, aliases, pack_size_kg: pack, packaging: str(body.packaging), location: str(body.location), gst_pct: gst, rows };
}

/** Minimal CSV parser that handles quoted fields. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) out.push(row);
  return out;
}

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
