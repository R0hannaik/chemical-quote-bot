import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings } from '../src/db/index.ts';
import { parseInquiry } from '../src/parser/parser.ts';
import { buildReply } from '../src/quote/build.ts';
import { formatQuantity, rupees } from '../src/quote/format.ts';
import { loadTemplates } from '../src/quote/store.ts';
import { render } from '../src/quote/templates.ts';
import { catalogFor, freshDb } from './helpers.ts';

const db = freshDb();
const now = new Date();
db.prepare('UPDATE price_rows SET updated_at = ?').run(now.toISOString());
const settings = { ...getSettings(db), contact_phone: '+91 90000 00000' };
const quote = (m: string) => {
  const cat = catalogFor(db);
  return buildReply(parseInquiry(m, cat), cat, settings, loadTemplates(db), now);
};

test('render drops lines whose variables are empty', () => {
  assert.equal(render('A {x}\nB {y}\nC', { x: '1', y: '' }), 'A 1\nC');
});

test('Indian number formatting', () => {
  assert.equal(rupees(123456.5), '₹1,23,456.50');
  assert.equal(formatQuantity({ value: 1, unit: 'ton', kg: 1000 }), '1 ton');
  assert.equal(formatQuantity({ value: 10, unit: 'ton', kg: 10000 }), '10 tons');
  assert.equal(formatQuantity({ value: 1300, unit: 'kg', kg: 1300 }), '1,300 kg');
  assert.equal(formatQuantity({ value: 3, unit: 'drum', kg: 645 }), '3 drums (645 kg)');
});

test('single-item quote', () => {
  const r = quote('PA kya rate chal raha hai 2 ton ka?');
  assert.equal(r.kind, 'quote');
  assert.equal((r as any).body, [
    '*Pawan Chemicals*',
    '📦 *Product:* Phthalic Anhydride',
    '🏷️ *Brand:* IGPL (India)',
    '💰 *Rate:* ₹199.00 / kg (+ 18% GST)',
    '📦 *Packaging:* 25 kg Bag',
    '📍 *Location:* Bhiwandi / Mumbai Ex-Godown',
    '✅ *Status:* Subject to Confirmation',
    '📝 *Requirement:* 2 tons',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '_Rates subject to day-to-day market changes. For booking confirmation or orders, please connect directly._',
    '*Pawan Chemicals* | 📞 +91 90000 00000',
  ].join('\n'));
});

test('several origins are listed cheapest first, and no requirement line without a quantity', () => {
  const body = (quote('Acrylic rate') as any).body as string;
  assert.match(body, /• China \(Satellite\): ₹138\.00 \/ kg\n• Indonesia \(Nippon Shokubai\): ₹144\.00 \/ kg\n• Korea \(LG Chem\): ₹150\.00 \/ kg/);
  assert.doesNotMatch(body, /Requirement/);
});

test('a named origin shows only that row', () => {
  const body = (quote('korea acrylic 5 ton rate') as any).body as string;
  assert.match(body, /LG Chem \(Korea\)/);
  assert.doesNotMatch(body, /Satellite/);
});

test('multi-item quote numbers each item', () => {
  const body = (quote('npg 10 bags china jiuan pg tech 3 drums china') as any).body as string;
  assert.match(body, /Quotation for 2 items/);
  assert.match(body, /\*1\.\* 📦 \*Product:\* Neopentyl Glycol/);
  assert.match(body, /\*2\.\* 📦 \*Product:\* Propylene Glycol/);
  assert.match(body, /10 bags \(250 kg\)/);
  assert.match(body, /3 drums \(645 kg\)/);
});
