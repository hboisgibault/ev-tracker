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
const xlsx = require('@e965/xlsx');

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
      6: 'OTHER',
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
      OTHER: 10,
    });
  });
});

describe('French SDES workbook (real layout, proven 2026-09-18)', () => {
  // Exact header + 2011_01 row from the SDES workbook. The "y compris"
  // columns are redundant totals (133299 + 12 = 133311): mapping them used
  // to double the whole market (~369k persisted for 188950 real).
  const header = [
    null,
    'Gazole (thermique)',
    'Essence (thermique)',
    'hybride gazole non rechargeable',
    'hybride essence non rechargeable',
    'gazole\n(y compris hybrides non rechargeables)',
    'essence\n(y compris hybrides non rechargeables)',
    'hybride rechargeable',
    'Electrique',
    'Gaz & ND',
    'Total',
  ];
  const row2011_01 = ['2011_01', 133299, 50320, 12, 896, 133311, 51216, 3, 100, 4320, 188950];

  it('ignores redundant "y compris" totals and the Total column', () => {
    const { colMapping } = findFrenchHeader([[], [], header]);
    expect(colMapping).toEqual({
      1: 'DIESEL',
      2: 'GASOLINE',
      3: 'HYBRID',
      4: 'HYBRID',
      7: 'PHEV',
      8: 'BEV',
      9: 'OTHER',
    });
  });

  it('aggregates 2011_01 to the published Total (no double count)', () => {
    const { colMapping } = findFrenchHeader([[], [], header]);
    const agg = aggregateFrenchRow(row2011_01, colMapping);
    expect(agg).toEqual({
      DIESEL: 133299,
      GASOLINE: 50320,
      HYBRID: 908,
      PHEV: 3,
      BEV: 100,
      OTHER: 4320,
    });
    expect(Object.values(agg).reduce((a, b) => a + b, 0)).toBe(188950);
  });
});
