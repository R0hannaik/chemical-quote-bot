import type { Quantity } from '../parser/parser.ts';

const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** ₹1,23,456.00 */
export const rupees = (n: number) => `₹${money.format(n)}`;

const UNIT_WORDS: Record<Quantity['unit'], [string, string]> = {
  kg: ['kg', 'kg'], ton: ['ton', 'tons'], bag: ['bag', 'bags'], drum: ['drum', 'drums'], carboy: ['carboy', 'carboys'],
  ibc: ['IBC', 'IBCs'], tanker: ['tanker', 'tankers'], jumbo: ['jumbo bag', 'jumbo bags'],
};

/** "1 ton", "10 tons", "1,300 kg", "3 drums (645 kg)" */
export function formatQuantity(q: Quantity): string {
  const [one, many] = UNIT_WORDS[q.unit];
  const base = `${qty.format(q.value)} ${q.value === 1 ? one : many}`;
  if (q.unit !== 'kg' && q.unit !== 'ton' && q.kg) return `${base} (${qty.format(q.kg)} kg)`;
  return base;
}
