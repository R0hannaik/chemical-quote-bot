/**
 * Text normalisation shared by the parser and by alias storage, so that
 * "P.A.", "pa", "SG-5" and "sg5" all compare equal to how aliases are stored.
 */

/** Common misspellings brokers type, mapped to the catalogue spelling (applied per token). */
export const SPELLING: Record<string, string> = {
  pthalic: 'phthalic', phtalic: 'phthalic', phthalik: 'phthalic', thalic: 'phthalic',
  malic: 'maleic', maliec: 'maleic', malaic: 'maleic', meleic: 'maleic',
  boiko: 'boeko', boeco: 'boeko',
  melamin: 'melamine', melamaine: 'melamine', melmine: 'melamine',
  glycerin: 'glycerine', glycrine: 'glycerine',
  acrlic: 'acrylic', acrylik: 'acrylic', acrilic: 'acrylic',
  benzoik: 'benzoic', bezoic: 'benzoic',
  adepic: 'adipic', adipik: 'adipic',
  phosporic: 'phosphoric', phospheric: 'phosphoric',
  citrik: 'citric',
  satelite: 'satellite',
  sakubai: 'shokubai', shokubhai: 'shokubai',
  mitusubishi: 'mitsubishi',
  hitech: 'hi tech', 'hi-tech': 'hi tech',
  kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  tonne: 'ton', tonnes: 'ton', tons: 'ton', mts: 'mt', mtr: 'mt',
  bags: 'bag', drums: 'drum', carboys: 'carboy', tankers: 'tanker', ibcs: 'ibc', jumbos: 'jumbo',
  plz: 'pls', please: 'pls', plss: 'pls',
};

/** Lower-cases and splits text into tokens. Punctuation becomes a separator except "?" which is kept as a token. */
export function tokenize(text: string): string[] {
  let s = text.toLowerCase();
  s = s.replace(/[‘’“”]/g, "'");
  s = s.replace(/(\d),(\d{2,3})/g, '$1$2');            // 1,300 -> 1300 (also Indian 1,00,000)
  s = s.replace(/(\d),(\d{2,3})/g, '$1$2');
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, '');             // drop dots unless they sit between digits (p.a. -> pa, 2.5 stays)
  s = s.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2'); // sg5 -> sg 5, 5000kgs -> 5000 kgs
  s = s.replace(/,/g, ' , ');
  s = s.replace(/\?/g, ' ? ');
  s = s.replace(/₹/g, ' rs ');
  s = s.replace(/@/g, ' @ ');
  s = s.replace(/&/g, ' & ');
  s = s.replace(/[^a-z0-9.?@&,\s]/g, ' ');                // emoji, *, -, /, %, etc.
  const out: string[] = [];
  for (const t of s.split(/\s+/)) {
    if (!t) continue;
    const mapped = SPELLING[t] ?? t;
    out.push(...mapped.split(' '));
  }
  return out;
}

/** Canonical form of an alias or brand: tokens joined by single spaces. */
export function normaliseTerm(term: string): string {
  return tokenize(term).filter((t) => t !== '?' && t !== ',').join(' ');
}

/** Levenshtein distance, used to spot near-miss product words. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
