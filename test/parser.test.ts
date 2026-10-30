import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInquiry } from '../src/parser/parser.ts';
import { catalogFor, freshDb } from './helpers.ts';

const cat = catalogFor(freshDb());
const parse = (m: string) => parseInquiry(m, cat);
const summary = (m: string) =>
  parse(m).items.map((i) => ({
    p: i.productName.split(' (')[0],
    q: i.quantity ? `${i.quantity.value} ${i.quantity.unit}` : null,
    ...(i.brand ? { b: i.brand, stocked: i.brandStocked } : {}),
    ...(i.origin ? { o: i.origin } : {}),
  }));

// ----- Every case from the TRD's "test cases from the prototype's live replies" table -----

test('PTA inquiry is recognised (the no-price block happens in the quote builder)', () => {
  assert.deepEqual(summary('pta rate pls'), [{ p: 'Purified Terephthalic Acid', q: null }]);
});

test('two products joined by "and" are both quoted', () => {
  assert.deepEqual(summary('MELA AND AA RATE PLS'), [{ p: 'Melamine', q: null }, { p: 'Acrylic Acid', q: null }]);
});

test('each quantity stays with its own product', () => {
  assert.deepEqual(summary('msg 10 tons melamine 4000kgs'), [
    { p: 'Monosodium Glutamate', q: '10 ton' },
    { p: 'Melamine', q: '4000 kg' },
  ]);
});

test('benzoic bags and PG drums are two items', () => {
  assert.deepEqual(summary('benzoic 10 bags pg tech 3 drums china'), [
    { p: 'Benzoic Acid', q: '10 bag' },
    { p: 'Propylene Glycol', q: '3 drum', o: 'China' },
  ]);
});

test('NPG with brand and origin, then PG', () => {
  assert.deepEqual(summary('npg 10 bags china jiuan pg tech 3 drums china'), [
    { p: 'Neopentyl Glycol', q: '10 bag', b: 'Jiuan', stocked: true, o: 'China' },
    { p: 'Propylene Glycol', q: '3 drum', o: 'China' },
  ]);
});

test('a requested brand that is not stocked is flagged, quantity kept', () => {
  assert.deepEqual(summary('10 ton Msg 30 / 40 mesh Imm payment Price pls *Fufeng first priority'), [
    { p: 'Monosodium Glutamate', q: '10 ton', b: 'Fufeng', stocked: false },
  ]);
});

test('quantity after a long product name', () => {
  assert.deepEqual(summary('Tri methylol propane (TMP) 1300 kgs 70days rt&mk'), [{ p: 'Trimethylolpropane', q: '1300 kg' }]);
});

test('booking intent goes to approval', () => {
  const r = parse('Bhai booking confirm karo 10 ton PA');
  assert.equal(r.intent, 'booking');
  assert.deepEqual(summary('Bhai booking confirm karo 10 ton PA'), [{ p: 'Phthalic Anhydride', q: '10 ton' }]);
});

// ----- More real-world phrasing -----

const priceCases: [string, ReturnType<typeof summary>][] = [
  ['PA kya rate chal raha hai 2 ton ka?', [{ p: 'Phthalic Anhydride', q: '2 ton' }]],
  ['hi tech pg 20 drums', [{ p: 'Propylene Glycol', q: '20 drum', b: 'Hi Tech', stocked: true }]],
  ['Wells tech pg 20 drums', [{ p: 'Propylene Glycol', q: '20 drum', b: 'Wells', stocked: true }]],
  ['10ton malic China boiko rate?', [{ p: 'Maleic Anhydride', q: '10 ton', b: 'Boeko', stocked: true, o: 'China' }]],
  ['Benzo and maleic rate Both 5000kgs', [{ p: 'Benzoic Acid', q: '5000 kg' }, { p: 'Maleic Anhydride', q: '5000 kg' }]],
  ['pvc and cam rate pls', [{ p: 'PVC Resin', q: null }, { p: 'Citric Acid Monohydrate', q: null }]],
  ['sg5 rate pls?', [{ p: 'PVC Resin', q: null, b: 'SG-5', stocked: true }]],
  ['pvc sg5 10 ton', [{ p: 'PVC Resin', q: '10 ton', b: 'SG-5', stocked: true }]],
  ['Korea acrylic, china maleic rate', [{ p: 'Acrylic Acid', q: null, o: 'Korea' }, { p: 'Maleic Anhydride', q: null, o: 'China' }]],
  ['Phosphoric acid 85% 2 ton', [{ p: 'Phosphoric Acid 85%', q: '2 ton' }]],
  ['pa 85 rate', [{ p: 'Phosphoric Acid 85%', q: null }]],
  ['MSG?5000 TONS', [{ p: 'Monosodium Glutamate', q: '5000 ton' }]],
  ['Pthalic rate?', [{ p: 'Phthalic Anhydride', q: null }]],
  ['Melamine rate?', [{ p: 'Melamine', q: null }]],
  ['AA RATE 5 TONS?', [{ p: 'Acrylic Acid', q: '5 ton' }]],
  ['tmp 1 ton?', [{ p: 'Trimethylolpropane', q: '1 ton' }]],
  ['need 2.5 mt adipic acid', [{ p: 'Adipic Acid', q: '2.5 ton' }]],
  ['h2o2 50% 1,300 kg chahiye', [{ p: 'Hydrogen Peroxide 50%', q: '1300 kg' }]],
  ['Glycerin 4 drums bhiwandi', [{ p: 'Refined Glycerine CP', q: '4 drum' }]],
  ['PA 2 ton\nMA 5 ton', [{ p: 'Phthalic Anhydride', q: '2 ton' }, { p: 'Maleic Anhydride', q: '5 ton' }]],
  ['dcda available?', [{ p: 'Dicyandiamide', q: null }]],
  ['Citric mono 200 bags rate', [{ p: 'Citric Acid Monohydrate', q: '200 bag' }]],
];

for (const [msg, expected] of priceCases) {
  test(`price inquiry: ${msg.replace(/\n/g, ' / ')}`, () => {
    const r = parse(msg);
    assert.equal(r.intent, 'price');
    assert.equal(r.confidence, 'high');
    assert.deepEqual(summary(msg), expected);
  });
}

test('bag count is converted to kg using the pack size', () => {
  const [item] = parse('pg 3 drums').items;
  assert.equal(item.quantity?.kg, 645);
});

test('counter-offer is treated as negotiation', () => {
  assert.equal(parse('PA 10 ton @ 195 final karo').intent, 'booking');
  assert.equal(parse('acrylic 5 ton rs 140 me de do?').intent, 'booking');
});

test('a misspelt product goes to the unmatched list instead of being quoted', () => {
  const r = parse('acryllic rate?');
  assert.equal(r.confidence, 'low');
  assert.equal(r.nearMisses[0].suggestion, 'acrylic');
});

test('an inquiry for something not in the catalogue is low confidence', () => {
  const r = parse('caustic soda flakes rate pls');
  assert.equal(r.items.length, 0);
  assert.equal(r.confidence, 'low');
});

// ----- Ordinary chat that must not trigger a quote -----

const chat = [
  'good morning all', 'ISO certified supplier', 'Ma ka call aaya?', 'Pa ji kidhar ho?', 'ok', 'Thanks bhai',
  'Happy Diwali to all members 🪔', 'Please share your GST number', 'Truck reached Bhiwandi', 'Who is going to the expo?',
  'Payment done', 'Bhai call karo', 'meeting at 4 pm', 'Please add me to the group', 'What is the cam angle?',
  'iso tank available for hire', 'msg me when free', 'aa gaya bhai', 'pg exam results out', 'Kal godown band hai',
  'PVC pipe fitting work done', 'Saturday holiday', 'Congratulations!', 'call me', 'Noted with thanks',
  'Please remove spam messages', 'tmp folder full on laptop', 'link expired', 'Who has a tanker free for Vapi?',
  'Good night',
];

for (const msg of chat) {
  test(`no reply to chat: ${msg}`, () => {
    const r = parse(msg);
    assert.ok(r.intent === 'none' || r.confidence !== 'high', `would reply to "${msg}" (${r.intent}, ${r.items.map((i) => i.productName)})`);
  });
}
