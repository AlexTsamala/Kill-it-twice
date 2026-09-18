export const PRODUCT_CSV_COLUMNS = ['sku', 'name', 'description', 'price', 'status'] as const;

const ADJECTIVES = [
  'Compact', 'Rugged', 'Polished', 'Matte', 'Insulated', 'Foldable', 'Adjustable',
  'Reinforced', 'Lightweight', 'Heavy-Duty', 'Precision', 'Vintage', 'Modular', 'Seamless',
  'Ergonomic', 'Weatherproof',
] as const;

const MATERIALS = [
  'Titanium', 'Walnut', 'Copper', 'Canvas', 'Ceramic', 'Bamboo', 'Granite', 'Leather',
  'Aluminium', 'Linen', 'Carbon', 'Oak',
] as const;

const NOUNS = [
  'Kettle', 'Lantern', 'Toolkit', 'Satchel', 'Tripod', 'Planter', 'Decanter', 'Bracket',
  'Notebook', 'Stool', 'Cutting Board', 'Thermos', 'Doorstop', 'Bookend', 'Colander',
  'Watering Can',
] as const;

const CATEGORIES = [
  'kitchen', 'outdoor', 'workshop', 'office', 'garden', 'travel', 'lighting', 'storage',
] as const;

const STATUSES = ['active', 'draft', 'archived'] as const;

const ADJECTIVE_SALT = 0x9e37;
const MATERIAL_SALT = 0x85eb;
const NOUN_SALT = 0xc2b2;
const CATEGORY_SALT = 0x27d4;
const LOT_SALT = 0x165667;
const PRICE_SALT = 0xd3a2;
const STATUS_SALT = 0x1b87;

function deterministicHash(value: number, salt: number): number {
  let hashed = (value ^ salt) >>> 0;
  hashed = Math.imul(hashed ^ (hashed >>> 16), 2246822507) >>> 0;
  hashed = Math.imul(hashed ^ (hashed >>> 13), 3266489909) >>> 0;
  return (hashed ^ (hashed >>> 16)) >>> 0;
}

function pick<Value>(values: readonly Value[], index: number, salt: number): Value {
  const chosen = values[deterministicHash(index, salt) % values.length];
  if (chosen === undefined) {
    throw new Error('word list is empty');
  }
  return chosen;
}

function quoteCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildName(index: number): string {
  const adjective = pick(ADJECTIVES, index, ADJECTIVE_SALT);
  const material = pick(MATERIALS, index, MATERIAL_SALT);
  const noun = pick(NOUNS, index, NOUN_SALT);
  return `${adjective} ${material} ${noun}`;
}

function buildDescription(index: number, name: string): string {
  const category = pick(CATEGORIES, index, CATEGORY_SALT);
  const lotNumber = (deterministicHash(index, LOT_SALT) % 9000) + 1000;
  return `${name} for everyday ${category} use. Ships from lot ${lotNumber} with a two-year guarantee.`;
}

function buildPrice(index: number): string {
  return (((deterministicHash(index, PRICE_SALT) % 99_900) + 100) / 100).toFixed(2);
}

export function buildProductCsvRow(index: number): string {
  const name = buildName(index);

  const fields = [
    quoteCsv(`SKU-${String(index).padStart(8, '0')}`),
    quoteCsv(name),
    quoteCsv(buildDescription(index, name)),
    buildPrice(index),
    quoteCsv(pick(STATUSES, index, STATUS_SALT)),
  ];

  return `${fields.join(',')}\n`;
}
