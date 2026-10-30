import { openDb, getSettings, type DB } from '../src/db/index.ts';
import { buildCatalog, loadProducts, type Catalog } from '../src/catalog/catalog.ts';

export function freshDb(): DB {
  return openDb(':memory:');
}

export function catalogFor(db: DB): Catalog {
  return buildCatalog(loadProducts(db), getSettings(db).known_brands);
}

export function productId(db: DB, nameStart: string): number {
  const row = db.prepare('SELECT id FROM products WHERE name LIKE ?').get(`${nameStart}%`) as { id: number } | undefined;
  if (!row) throw new Error(`No product ${nameStart}`);
  return row.id;
}
