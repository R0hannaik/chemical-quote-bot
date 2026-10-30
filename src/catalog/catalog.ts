import type { DB } from '../db/index.ts';
import { normaliseTerm } from '../parser/normalise.ts';

/** Fixed list of origins: picking from a list stops "China" and "china" becoming two rows. */
export const ORIGINS = ['India', 'China', 'Korea', 'Japan', 'Taiwan', 'Indonesia', 'Thailand', 'Vietnam', 'Malaysia',
  'Saudi Arabia', 'UAE', 'Iran', 'Russia', 'USA', 'Germany', 'Spain', 'Belgium', 'Netherlands', 'Other'] as const;

export const STOCK_STATUSES = ['In Stock', 'Limited Stock', 'Subject to Confirmation', 'Out of Stock'] as const;

export interface PriceRow {
  id: number; product_id: number; origin: string; brand: string; rate: number | null; status: string;
  freshness_hours: number; updated_at: string; updated_by: string | null;
}

export interface Product {
  id: number; name: string; aliases: string[]; unit: string; pack_size_kg: number | null; packaging: string;
  location: string; gst_pct: number; active: boolean; rows: PriceRow[];
}

export interface AliasEntry { productId: number; alias: string; tokens: string[]; short: boolean }

export interface Catalog {
  products: Map<number, Product>;
  /** Aliases sorted longest first (by token count, then characters). */
  aliases: AliasEntry[];
  /** Every multi-character single-word alias, for near-miss detection. */
  singleWords: Set<string>;
  knownBrands: string[];
}

export function loadProducts(db: DB, includeInactive = false): Product[] {
  const prods = db.prepare(`SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`).all() as any[];
  const rows = db.prepare('SELECT * FROM price_rows ORDER BY rate').all() as unknown as PriceRow[];
  const byProduct = new Map<number, PriceRow[]>();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id)!.push(r);
  }
  return prods.map((p) => ({ ...p, aliases: JSON.parse(p.aliases), active: !!p.active, rows: byProduct.get(p.id) ?? [] }));
}

export function buildCatalog(products: Product[], knownBrands: string[]): Catalog {
  const aliases: AliasEntry[] = [];
  const singleWords = new Set<string>();
  for (const p of products) {
    if (!p.active) continue;
    const names = new Set([...p.aliases, p.name.replace(/\(.*?\)/g, '')].map(normaliseTerm).filter(Boolean));
    for (const alias of names) {
      const tokens = alias.split(' ');
      aliases.push({ productId: p.id, alias, tokens, short: alias.replace(/ /g, '').length <= 3 });
      if (tokens.length === 1 && alias.length >= 5) singleWords.add(alias);
    }
  }
  aliases.sort((a, b) => b.tokens.length - a.tokens.length || b.alias.length - a.alias.length);
  return {
    products: new Map(products.map((p) => [p.id, p])),
    aliases,
    singleWords,
    knownBrands: knownBrands.map(normaliseTerm),
  };
}

/** Returns the name of the other product that already uses one of these aliases, if any. */
export function findAliasClash(products: Product[], aliases: string[], excludeId?: number): { alias: string; product: string } | null {
  const wanted = new Map(aliases.map((a) => [normaliseTerm(a), a]));
  for (const p of products) {
    if (p.id === excludeId) continue;
    for (const a of p.aliases) {
      const n = normaliseTerm(a);
      if (wanted.has(n)) return { alias: wanted.get(n)!, product: p.name };
    }
  }
  return null;
}
