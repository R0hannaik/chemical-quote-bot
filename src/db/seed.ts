import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TEMPLATES } from '../quote/templates.ts';

interface SeedRow { origin: string; brand: string; rate: number; status?: string }
interface SeedProduct {
  name: string; aliases: string[]; pack_size_kg: number; packaging: string; location?: string; rows: SeedRow[];
}

const GODOWN = 'Bhiwandi / Mumbai Ex-Godown';

/**
 * Starting catalogue, taken from the prototype's rate list with its data errors fixed
 * (spellings, brand/origin mismatches, duplicate "China"/"china" rows, Ajinomoto as an MSG alias).
 * Rates are sample values: confirm them in the dashboard before going live.
 */
export const SEED_PRODUCTS: SeedProduct[] = [
  { name: 'Phthalic Anhydride', aliases: ['pa', 'p.a.', 'phthalic', 'phthalic anhydride'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'India', brand: 'IGPL', rate: 199, status: 'Subject to Confirmation' }] },
  { name: 'Acrylic Acid', aliases: ['aa', 'a.a.', 'acrylic', 'acrylic acid'], pack_size_kg: 200, packaging: '200 kg Drum',
    rows: [{ origin: 'Korea', brand: 'LG Chem', rate: 150 }, { origin: 'Indonesia', brand: 'Nippon Shokubai', rate: 144 },
      { origin: 'China', brand: 'Satellite', rate: 138 }] },
  { name: 'Maleic Anhydride', aliases: ['ma', 'm.a.', 'maleic', 'maleic anhydride'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'Boeko', rate: 174 }, { origin: 'China', brand: 'Tengda', rate: 178 },
      { origin: 'Korea', brand: 'MCI', rate: 185 }] },
  { name: 'Monosodium Glutamate (MSG)', aliases: ['msg', 'm.s.g.', 'monosodium glutamate'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'Meihua', rate: 120, status: 'Limited Stock' }] },
  { name: 'Purified Terephthalic Acid (PTA)', aliases: ['pta', 'p.t.a.', 'terephthalic acid', 'purified terephthalic acid'],
    pack_size_kg: 1200, packaging: '1,200 kg Jumbo Bag', location: 'Ex-Plant / Bhiwandi', rows: [] },
  { name: 'Benzoic Acid', aliases: ['benzoic', 'benzoic acid', 'benzo'], pack_size_kg: 25, packaging: '25 kg Bag', location: 'Bhiwandi Ex-Godown',
    rows: [{ origin: 'China', brand: 'Wuhan', rate: 157 }] },
  { name: 'Refined Glycerine CP', aliases: ['glycerine', 'glycerin', 'refined glycerine', 'cp glycerine'], pack_size_kg: 250,
    packaging: '250 kg HDPE Drum', location: 'Bhiwandi Ex-Godown', rows: [{ origin: 'India', brand: 'DCM', rate: 142, status: 'Subject to Confirmation' }] },
  { name: 'Hydrogen Peroxide 50%', aliases: ['hydrogen peroxide', 'h2o2', 'peroxide'], pack_size_kg: 50, packaging: '50 kg HMHDPE Drum',
    location: 'Bhiwandi Ex-Godown', rows: [{ origin: 'India', brand: 'National Peroxide', rate: 44 }] },
  { name: 'Propylene Glycol (PG)', aliases: ['pg', 'p.g.', 'propylene glycol', 'pg tech', 'mpg'], pack_size_kg: 215, packaging: '215 kg Drum',
    location: 'Bhiwandi Ex-Godown',
    rows: [{ origin: 'China', brand: 'Wells', rate: 155, status: 'Subject to Confirmation' }, { origin: 'China', brand: 'Hi Tech', rate: 154, status: 'Subject to Confirmation' }] },
  { name: 'Phosphoric Acid 85%', aliases: ['phosphoric', 'phosphoric acid', 'pa 85', 'orthophosphoric'], pack_size_kg: 35,
    packaging: '35 kg Carboy', rows: [{ origin: 'China', brand: '', rate: 122 }, { origin: 'Taiwan', brand: '', rate: 128 },
      { origin: 'Vietnam', brand: '', rate: 125 }] },
  { name: 'Dicyandiamide (DCDA)', aliases: ['dcda', 'd.c.d.a.', 'dicyandiamide', 'dicyan'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'DADI', rate: 198, status: 'Subject to Confirmation' }] },
  { name: 'Adipic Acid', aliases: ['adipic', 'adipic acid'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'Shandong Haili', rate: 162, status: 'Subject to Confirmation' }] },
  { name: 'Melamine', aliases: ['melamine', 'mela'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'Shuntian', rate: 106.5, status: 'Subject to Confirmation' }] },
  { name: 'Purified Isophthalic Acid (PIA)', aliases: ['pia', 'iso', 'isophthalic', 'isophthalic acid', 'purified isophthalic acid'],
    pack_size_kg: 25, packaging: '25 kg Bag', rows: [{ origin: 'Korea', brand: '', rate: 132, status: 'Subject to Confirmation' }] },
  { name: 'Trimethylolpropane (TMP)', aliases: ['tmp', 't.m.p.', 'trimethylolpropane', 'tri methylol propane'], pack_size_kg: 25,
    packaging: '25 kg Bag', rows: [{ origin: 'China', brand: 'BCC Chem', rate: 180, status: 'Subject to Confirmation' }] },
  { name: 'Hydrocarbon Resin', aliases: ['hydrocarbon resin', 'c9 resin', 'c5 resin', 'c9', 'c5'], pack_size_kg: 20, packaging: '20 kg Bag',
    rows: [{ origin: 'China', brand: 'Impera', rate: 98 }] },
  { name: 'Neopentyl Glycol (NPG)', aliases: ['npg', 'n.p.g.', 'neopentyl glycol', 'neo pentyl glycol'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'Jiuan', rate: 158, status: 'Subject to Confirmation' }, { origin: 'Japan', brand: 'Mitsubishi', rate: 164, status: 'Subject to Confirmation' },
      { origin: 'Indonesia', brand: 'PN', rate: 162, status: 'Subject to Confirmation' }] },
  { name: 'Pentaerythritol 96%', aliases: ['penta', 'pentaerythritol', 'penta 96'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: '', rate: 235 }] },
  { name: 'Citric Acid Monohydrate', aliases: ['cam', 'citric', 'citric acid', 'citric mono', 'citric acid monohydrate'], pack_size_kg: 25,
    packaging: '25 kg Bag', rows: [{ origin: 'China', brand: 'Ensign', rate: 96 }, { origin: 'China', brand: 'Weifang', rate: 96 }] },
  { name: 'PVC Resin', aliases: ['pvc', 'pvc resin', 'polyvinyl chloride', 'sg5', 'sg-5', 'k67'], pack_size_kg: 25, packaging: '25 kg Bag',
    rows: [{ origin: 'China', brand: 'SG-5', rate: 95 }, { origin: 'China', brand: 'K67', rate: 95 }] },
];

export function seedIfEmpty(db: DatabaseSync) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
  if (n === 0) {
    const insP = db.prepare('INSERT INTO products(name, aliases, pack_size_kg, packaging, location) VALUES(?,?,?,?,?)');
    const insR = db.prepare('INSERT INTO price_rows(product_id, origin, brand, rate, status, updated_by) VALUES(?,?,?,?,?,?)');
    for (const p of SEED_PRODUCTS) {
      const { lastInsertRowid } = insP.run(p.name, JSON.stringify(p.aliases), p.pack_size_kg, p.packaging, p.location ?? GODOWN);
      for (const r of p.rows) insR.run(lastInsertRowid, r.origin, r.brand, r.rate, r.status ?? 'In Stock', 'seed');
    }
  }
  const { t } = db.prepare('SELECT COUNT(*) AS t FROM templates').get() as { t: number };
  if (t === 0) {
    const ins = db.prepare('INSERT INTO templates(mode, body, version, active, created_by) VALUES(?,?,1,1,?)');
    for (const [mode, body] of Object.entries(DEFAULT_TEMPLATES)) ins.run(mode, body, 'seed');
  }
}
