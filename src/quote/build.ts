import type { Catalog, PriceRow, Product } from '../catalog/catalog.ts';
import type { Settings } from '../db/index.ts';
import type { ParsedItem, ParseResult } from '../parser/parser.ts';
import { formatQuantity, rupees } from './format.ts';
import { render, type TemplateMode } from './templates.ts';

export type Templates = Record<TemplateMode, string> & { version: number };

export type BuildResult =
  | { kind: 'quote'; body: string; templateVersion: number }
  | { kind: 'booking'; body: string; templateVersion: number }
  | { kind: 'held'; body: string | null; reasons: string[]; templateVersion: number }
  | { kind: 'none'; reasons: string[] };

/** Why a price row cannot be quoted, or null if it can. */
export function rowProblem(row: PriceRow, now: Date): string | null {
  if (row.rate === null || !(row.rate > 0)) return 'no price set';
  const ageH = (now.getTime() - Date.parse(row.updated_at)) / 3_600_000;
  if (ageH > row.freshness_hours) return `price not confirmed for ${Math.floor(ageH)} h (limit ${row.freshness_hours} h)`;
  return null;
}

const rowLabel = (r: PriceRow) => (r.brand ? `${r.origin} (${r.brand})` : r.origin);

interface ItemBlock { vars: Record<string, string | null>; problems: string[] }

function itemBlock(item: ParsedItem, product: Product, now: Date): ItemBlock {
  let rows = product.rows;
  const notes: string[] = [];

  if (item.brand && item.brandStocked) rows = rows.filter((r) => r.brand === item.brand);
  else if (item.brand && !item.brandStocked) notes.push(`${item.brand} is not available with us; stocked options below.`);

  if (item.origin && item.originStocked) {
    const byOrigin = rows.filter((r) => r.origin === item.origin);
    if (byOrigin.length) rows = byOrigin;
  } else if (item.origin && !item.originStocked) notes.push(`${item.origin} origin is not available with us; stocked options below.`);

  const problems: string[] = [];
  const valid = rows.filter((r) => !rowProblem(r, now)).sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0));
  if (!rows.length) problems.push(`${product.name}: no price set`);
  else if (!valid.length) {
    for (const r of rows) problems.push(`${product.name} ${rowLabel(r)}: ${rowProblem(r, now)}`);
  }

  const gst = `(+ ${product.gst_pct}% GST)`;
  const unit = product.unit;
  let brand: string | null = null;
  let rate: string | null = null;
  let status: string | null = null;
  if (valid.length === 1) {
    const r = valid[0];
    brand = r.brand ? `${r.brand} (${r.origin})` : r.origin;
    rate = `${rupees(r.rate!)} / ${unit} ${gst}`;
    status = r.status;
  } else if (valid.length > 1) {
    const statuses = new Set(valid.map((r) => r.status));
    const same = statuses.size === 1;
    rate = '\n' + valid.map((r) => `• ${rowLabel(r)}: ${rupees(r.rate!)} / ${unit}${same ? '' : ` — ${r.status}`}`).join('\n') + `\n_${gst}_`;
    status = same ? valid[0].status : null;
  }

  return {
    problems,
    vars: {
      product_name: product.name,
      brand,
      rate_details: rate,
      packaging: product.packaging,
      location: product.location,
      status,
      requirement: item.quantity ? formatQuantity(item.quantity) : null,
      note: notes.join(' ') || null,
    },
  };
}

export function buildReply(parse: ParseResult, catalog: Catalog, settings: Settings, t: Templates, now = new Date()): BuildResult {
  if (parse.intent === 'none' || parse.confidence === 'none') return { kind: 'none', reasons: ['Not an inquiry'] };
  if (parse.confidence === 'low') return { kind: 'none', reasons: parse.reasons.length ? parse.reasons : ['Low confidence'] };

  const common = {
    business_name: settings.business_name,
    contact_name: settings.contact_name,
    contact_phone: settings.contact_phone,
  };

  if (parse.intent === 'booking') {
    const names = parse.items.map((i) => i.productName).join(', ');
    const reqs = parse.items.filter((i) => i.quantity).map((i) =>
      parse.items.length > 1 ? `${i.productName} ${formatQuantity(i.quantity!)}` : formatQuantity(i.quantity!));
    const body = render(t.booking, { ...common, product_name: names, requirement: reqs.join(', ') });
    return { kind: 'booking', body, templateVersion: t.version };
  }

  const blocks = parse.items.map((item) => itemBlock(item, catalog.products.get(item.productId)!, now));
  const parts = [render(t.quote_header, common)];
  if (blocks.length > 1) parts.push(render(t.quote_multi_title, { item_count: blocks.length }));
  blocks.forEach((b, i) => {
    const body = render(t.quote_item, { ...common, ...b.vars });
    parts.push(blocks.length > 1 ? `━━━━━━━━━━━━━━━━━━━━━━\n*${i + 1}.* ${body}` : body);
  });
  parts.push(render(t.quote_footer, common));
  const body = parts.filter(Boolean).join('\n');

  const problems = blocks.flatMap((b) => b.problems);
  if (problems.length) return { kind: 'held', body, reasons: problems, templateVersion: t.version };
  return { kind: 'quote', body, templateVersion: t.version };
}
