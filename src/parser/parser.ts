import type { Catalog, Product } from '../catalog/catalog.ts';
import { editDistance, normaliseTerm, tokenize } from './normalise.ts';

export type Unit = 'kg' | 'ton' | 'bag' | 'drum' | 'carboy' | 'ibc' | 'tanker' | 'jumbo';

export interface Quantity { value: number; unit: Unit; kg: number | null }

export interface ParsedItem {
  productId: number;
  productName: string;
  aliases: string[];
  quantity: Quantity | null;
  /** Brand asked for (display form), whether or not it is stocked. */
  brand: string | null;
  brandStocked: boolean | null;
  origin: string | null;
  originStocked: boolean | null;
}

export type Intent = 'price' | 'booking' | 'none';
export type Confidence = 'high' | 'low' | 'none';

export interface ParseResult {
  tokens: string[];
  items: ParsedItem[];
  intent: Intent;
  confidence: Confidence;
  nearMisses: { word: string; suggestion: string }[];
  reasons: string[];
}

// ---------- vocabulary ----------

const UNITS: Record<string, Unit> = {
  kg: 'kg', ton: 'ton', mt: 'ton', t: 'ton', bag: 'bag', drum: 'drum', carboy: 'carboy', ibc: 'ibc', tanker: 'tanker', jumbo: 'jumbo',
};
const PACK_WORDS: Partial<Record<Unit, string>> = { bag: 'bag', drum: 'drum', carboy: 'carboy', ibc: 'ibc', jumbo: 'jumbo' };

const PRICE_WORDS = new Set(['rate', 'rates', 'price', 'prices', 'pricing', 'quote', 'quotation', 'bhav', 'bhaav', 'offer', 'kitna',
  'kitne', 'available', 'avl', 'avail', 'availability', 'stock', 'landed', 'chahiye', 'chaiye', 'reqd', 'required', 'requirement',
  'need', 'needed', 'urgent', 'rt', 'kya']);
const BOOKING_WORDS = new Set(['confirm', 'confirmed', 'book', 'booking', 'booked', 'final', 'finalise', 'finalize', 'finalised',
  'finalized', 'deal', 'lock', 'locked', 'kardo', 'po']);
const SEPARATORS = new Set([',', 'and', '&', 'aur', '+', 'also', 'plus']);
const ALL_WORDS = new Set(['both', 'each', 'dono', 'all']);

const ORIGIN_WORDS: Record<string, string> = {
  china: 'China', chinese: 'China', korea: 'Korea', korean: 'Korea', japan: 'Japan', japanese: 'Japan', taiwan: 'Taiwan',
  indonesia: 'Indonesia', indo: 'Indonesia', india: 'India', indian: 'India', local: 'India', indigenous: 'India', domestic: 'India',
  thailand: 'Thailand', thai: 'Thailand', vietnam: 'Vietnam', malaysia: 'Malaysia', saudi: 'Saudi Arabia', uae: 'UAE', iran: 'Iran',
  russia: 'Russia', russian: 'Russia', usa: 'USA', germany: 'Germany', german: 'Germany', spain: 'Spain', belgium: 'Belgium',
  netherlands: 'Netherlands',
};

/** Ordinary words that should never be flagged as a misspelt product. */
const COMMON = new Set(['hello', 'thanks', 'thank', 'please', 'urgent', 'payment', 'immediate', 'delivery', 'first', 'priority',
  'today', 'tomorrow', 'morning', 'evening', 'market', 'group', 'bhiwandi', 'mumbai', 'gujarat', 'vapi', 'ankleshwar', 'chahiye',
  'second', 'quality', 'grade', 'technical', 'mesh', 'material', 'credit', 'advance', 'against', 'basis', 'ready', 'dispatch',
  'loading', 'location', 'godown', 'factory', 'plant', 'brand', 'origin', 'imported', 'import', 'sharing', 'details', 'contact',
  'number', 'buyer', 'seller', 'supplier', 'certified', 'chalega', 'milega', 'batao', 'bataye', 'bhejo', 'raha', 'rahe', 'about',
  'there', 'their', 'which', 'where', 'other', 'month', 'weeks', 'within', 'without', 'under', 'tanker', 'container']);

/** A product name followed by one of these words is something else ("iso tank", "pvc pipe", "msg me"). */
const NOT_PRODUCT_NEXT: Record<string, string[]> = {
  iso: ['tank', 'tanks', 'container', 'containers', 'certified', 'certificate', 'certification'],
  pvc: ['pipe', 'pipes', 'fitting', 'fittings', 'door', 'doors', 'card', 'cards', 'sheet', 'sheets'],
  pa: ['ji', 'system'],
  msg: ['me', 'karo', 'kar', 'kiya', 'kijiye'],
  aa: ['gaya', 'gayi', 'gaye', 'jao', 'raha', 'rahe', 'jaa'],
  tmp: ['folder', 'file', 'files'],
  pg: ['exam', 'course', 'college', 'hostel'],
  cam: ['angle', 'shaft', 'era'],
};

// ---------- helpers ----------

const isNumber = (t: string) => /^\d+(\.\d+)?$/.test(t);

function titleCase(s: string) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

interface Match { productId: number; start: number; end: number; alias: string; short: boolean }

function findMatches(tokens: string[], catalog: Catalog): Match[] {
  const out: Match[] = [];
  let i = 0;
  while (i < tokens.length) {
    let found: Match | null = null;
    for (const a of catalog.aliases) {
      if (a.tokens.length > tokens.length - i) continue;
      let ok = true;
      for (let k = 0; k < a.tokens.length; k++) if (tokens[i + k] !== a.tokens[k]) { ok = false; break; }
      if (ok) { found = { productId: a.productId, start: i, end: i + a.tokens.length, alias: a.alias, short: a.short }; break; }
    }
    if (found && NOT_PRODUCT_NEXT[found.alias]?.includes(tokens[found.end])) found = null;
    if (found) { out.push(found); i = found.end; } else i++;
  }
  return out;
}

/** Finds the first "number + unit" in a token span, skipping tokens already used by a product name. */
function findQuantity(tokens: string[], from: number, to: number, used: Set<number>, product: Product): Quantity | null {
  for (let i = from; i < to - 1; i++) {
    if (used.has(i) || !isNumber(tokens[i])) continue;
    const unit = UNITS[tokens[i + 1]];
    if (!unit || used.has(i + 1)) continue;
    const value = Number(tokens[i]);
    if (!(value > 0)) continue;
    return { value, unit, kg: toKg(value, unit, product) };
  }
  return null;
}

function toKg(value: number, unit: Unit, product: Product): number | null {
  if (unit === 'kg') return value;
  if (unit === 'ton') return value * 1000;
  const word = PACK_WORDS[unit];
  if (word && product.pack_size_kg && product.packaging.toLowerCase().includes(word)) return value * product.pack_size_kg;
  return null;
}

function findPhrase(tokens: string[], from: number, to: number, phrase: string): boolean {
  const p = phrase.split(' ');
  for (let i = from; i <= to - p.length; i++) {
    let ok = true;
    for (let k = 0; k < p.length; k++) if (tokens[i + k] !== p[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function findBrand(tokens: string[], from: number, to: number, product: Product, knownBrands: string[]) {
  const stocked = [...new Set(product.rows.map((r) => r.brand).filter(Boolean))]
    .map((b) => ({ display: b, norm: normaliseTerm(b) }))
    .sort((a, b) => b.norm.length - a.norm.length);
  for (const b of stocked) if (findPhrase(tokens, from, to, b.norm)) return { brand: b.display, stocked: true };
  const known = [...knownBrands].sort((a, b) => b.length - a.length);
  for (const b of known) if (findPhrase(tokens, from, to, b)) return { brand: titleCase(b), stocked: false };
  return null;
}

function findOrigin(tokens: string[], from: number, to: number, product: Product) {
  for (let i = from; i < to; i++) {
    const origin = ORIGIN_WORDS[tokens[i]];
    if (origin) return { origin, stocked: product.rows.some((r) => r.origin === origin) };
  }
  return null;
}

// ---------- main ----------

export function parseInquiry(text: string, catalog: Catalog): ParseResult {
  const tokens = tokenize(text.replace(/\n+/g, ' , '));
  const reasons: string[] = [];
  const has = (set: Set<string>) => tokens.some((t) => set.has(t));

  const hasPriceWord = has(PRICE_WORDS) || findPhrase(tokens, 0, tokens.length, 'chal raha');
  const counterOffer = tokens.some((t, i) => (t === '@' || t === 'rs') && isNumber(tokens[i + 1] ?? ''));
  const hasBookingWord = has(BOOKING_WORDS) || findPhrase(tokens, 0, tokens.length, 'kar do') || counterOffer;
  const hasQuestion = tokens.includes('?');

  const matches = findMatches(tokens, catalog);

  // Group consecutive matches of the same product ("pvc sg5") into one item.
  const groups: Match[][] = [];
  for (const m of matches) {
    const last = groups.at(-1);
    if (last && last.at(-1)!.productId === m.productId) last.push(m); else groups.push([m]);
  }

  const used = new Set<number>();
  for (const m of matches) for (let i = m.start; i < m.end; i++) used.add(i);

  // Work out the token span that belongs to each item.
  const spans: { from: number; to: number }[] = groups.map((g) => ({ from: g[0].start, to: g.at(-1)!.end }));
  for (let gi = 0; gi < spans.length; gi++) {
    if (gi === 0) spans[0].from = 0;
    const next = spans[gi + 1];
    const end = next ? next.from : tokens.length;
    if (next) {
      // Words between two products belong to the earlier one, unless a separator ("and", ",") hands them to the next.
      let sep = -1;
      for (let i = spans[gi].to; i < end; i++) if (SEPARATORS.has(tokens[i])) sep = i;
      if (sep >= 0) { next.from = sep + 1; spans[gi].to = sep; } else spans[gi].to = end;
    } else spans[gi].to = end;
  }

  const anyQuantity = groups.some((g, gi) => {
    const p = catalog.products.get(g[0].productId)!;
    return !!findQuantity(tokens, spans[gi].from, spans[gi].to, used, p);
  });

  let entries = groups.map((g, gi) => {
    const p = catalog.products.get(g[0].productId)!;
    const { from, to } = spans[gi];
    const brand = findBrand(tokens, from, to, p, catalog.knownBrands);
    const origin = findOrigin(tokens, from, to, p);
    const item: ParsedItem = {
      productId: p.id,
      productName: p.name,
      aliases: g.map((m) => m.alias),
      quantity: findQuantity(tokens, from, to, used, p),
      brand: brand?.brand ?? null,
      brandStocked: brand ? brand.stocked : null,
      origin: origin?.origin ?? null,
      originStocked: origin ? origin.stocked : null,
    };
    return { item, short: g.every((m) => m.short), alias: g[0].alias };
  });

  // Short aliases (pa, ma, iso, msg...) count only alongside an inquiry word or a quantity.
  entries = entries.filter((e) => {
    if (e.short && !hasPriceWord && !hasBookingWord && !anyQuantity) {
      reasons.push(`Ignored short name "${e.alias}" with no inquiry word or quantity`);
      return false;
    }
    return true;
  });
  const items = entries.map((e) => e.item);

  // "Benzo and maleic rate, both 5000 kgs": one quantity applies to every item.
  if (has(ALL_WORDS)) {
    const qs = items.filter((i) => i.quantity);
    if (qs.length === 1) {
      const q = qs[0].quantity!;
      for (const it of items) if (!it.quantity) {
        const p = catalog.products.get(it.productId)!;
        it.quantity = { ...q, kg: toKg(q.value, q.unit, p) };
      }
    }
  }

  // Product-looking words that are not in the catalogue.
  const nearMisses: ParseResult['nearMisses'] = [];
  tokens.forEach((t, i) => {
    if (used.has(i) || t.length < 5 || !/^[a-z]+$/.test(t)) return;
    if (PRICE_WORDS.has(t) || BOOKING_WORDS.has(t) || ORIGIN_WORDS[t] || COMMON.has(t)) return;
    if (catalog.knownBrands.some((b) => b.split(' ').includes(t))) return;
    const limit = t.length <= 6 ? 1 : 2;
    for (const w of catalog.singleWords) {
      if (Math.abs(w.length - t.length) <= limit && editDistance(t, w) <= limit) { nearMisses.push({ word: t, suggestion: w }); break; }
    }
  });

  const longItem = entries.some((e) => !e.short);
  let intent: Intent = 'none';
  if (hasBookingWord && (items.length || hasPriceWord)) intent = 'booking';
  else if (hasPriceWord || items.some((i) => i.quantity) || (hasQuestion && longItem)) intent = 'price';
  if (!items.length && !nearMisses.length && intent !== 'none' && !hasPriceWord) intent = 'none';

  let confidence: Confidence = 'none';
  if (intent !== 'none') {
    if (nearMisses.length) {
      confidence = 'low';
      reasons.push(`Possible misspelt product: ${nearMisses.map((n) => `"${n.word}" (${n.suggestion}?)`).join(', ')}`);
    } else if (!items.length) {
      confidence = 'low';
      reasons.push('Inquiry words found but no product from the catalogue');
    } else confidence = 'high';
  }

  return { tokens, items, intent, confidence, nearMisses, reasons };
}
