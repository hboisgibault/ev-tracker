import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeFrenchFuel,
  findFrenchHeader,
  aggregateFrenchRow,
} = require('../scripts/parsers/FR.js');
const xlsx = require('xlsx');

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixtureRows() {
  const wb = xlsx.readFile(join(fixturesDir, 'fr-sample.xlsx'));
  return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
}

describe('normalizeFrenchFuel', () => {
  it.each([
    ['Electrique', 'BEV'],
    ['Gazole (thermique)', 'DIESEL'],
    ['Essence (thermique)', 'GASOLINE'],
    ['hybride rechargeable', 'PHEV'],
    ['hybride essence non rechargeable', 'HYBRID'],
  ])('maps %s to %s', (label, expected) => {
    expect(normalizeFrenchFuel(label)).toBe(expected);
  });
});

describe('French XLSX fixture', () => {
  it('locates the header row and maps fuel columns', () => {
    const { headerIndex, colMapping, colDate } = findFrenchHeader(fixtureRows());
    expect(headerIndex).toBe(1);
    expect(colDate).toBe(0);
    expect(colMapping).toEqual({
      1: 'DIESEL',
      2: 'GASOLINE',
      3: 'BEV',
      4: 'PHEV',
      5: 'HYBRID',
    });
  });

  it('aggregates a data row into normalized fuel totals', () => {
    const rows = fixtureRows();
    const { headerIndex, colMapping } = findFrenchHeader(rows);
    expect(aggregateFrenchRow(rows[headerIndex + 1], colMapping)).toEqual({
      DIESEL: 100,
      GASOLINE: 200,
      BEV: 150,
      PHEV: 50,
      HYBRID: 80,
    });
  });
});
