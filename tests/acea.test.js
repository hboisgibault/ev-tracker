import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parsePdfData,
  rowNumbersFromItems,
  isMonthlyDataRow,
  YTD_ONLY_RELEASES,
  getAceaPdfUrls,
  assertPlausibleAceaData,
} = require('../scripts/parsers/ACEA.js');

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function byEnergie(rows) {
  return Object.fromEntries(rows.map((r) => [r.energie, r.total]));
}

describe('ACEA PDF extraction', () => {
  it('extracts the Spain row with exact fuel totals', async () => {
    const buffer = readFileSync(join(fixturesDir, 'acea-sample.pdf'));
    const rows = await parsePdfData(buffer, 'ES');
    expect(byEnergie(rows)).toEqual({
      BEV: 3375,
      PHEV: 4578,
      HYBRID: 26451,
      DIESEL: 7553,
      GASOLINE: 23966,
      OTHER: 2762,
    });
  });

  it('extracts the France row without cross-contamination', async () => {
    const buffer = readFileSync(join(fixturesDir, 'acea-sample.pdf'));
    const rows = await parsePdfData(buffer, 'ES');
    const frRows = await parsePdfData(buffer, 'FR');
    expect(byEnergie(frRows).BEV).toBe(2500);
    expect(byEnergie(frRows).BEV).not.toBe(byEnergie(rows).BEV);
  });

  it('throws for a country absent from the PDF', async () => {
    const buffer = readFileSync(join(fixturesDir, 'acea-sample.pdf'));
    await expect(parsePdfData(buffer, 'XX')).rejects.toThrow(/not found/i);
  });

  it('covers the known ACEA URL patterns', () => {
    const urls = getAceaPdfUrls(2025, 1);
    expect(urls.some((u) => u.includes('January_2025'))).toBe(true);
    expect(getAceaPdfUrls(2024, 1).some((u) => u.includes('January_2024'))).toBe(true);
  });

  it('marks the February 2025 YTD-only release as skipped (no monthly table)', () => {
    // Proven 2026-09-18: the Feb 2025 PDF holds Jan-Feb cumulative blocks,
    // so 2025-02 must never abort a country recollect loop.
    expect(YTD_ONLY_RELEASES.has('2025-02')).toBe(true);
  });
});

describe('ACEA dash handling (positional sentinels)', () => {
  // Exact Romania row shape from the January 2026 PDF (p3 y=213):
  // PHEV is a dash (ꟷ U+A7F7) while HEV holds 4642. Dropping the dashes
  // used to shift HEV into the PHEV slot (PHEV=4642, HYBRID=0).
  const romaniaItems = [
    { text: 'Romania', x: 0 },
    { text: '974', x: 1 },
    { text: '1,164', x: 2 },
    { text: '-16.3', x: 3 },
    { text: 'ꟷ', x: 4 },
    { text: 'ꟷ', x: 5 },
    { text: '4,642', x: 6 },
    { text: '5,284', x: 7 },
    { text: '-12.1', x: 8 },
    { text: '489', x: 9 },
    { text: '1,511', x: 10 },
    { text: '-67.6', x: 11 },
    { text: '1,280', x: 12 },
    { text: '3,002', x: 13 },
    { text: '-57.4', x: 14 },
    { text: '542', x: 15 },
    { text: '959', x: 16 },
    { text: '-43.5', x: 17 },
    { text: '7,927', x: 18 },
    { text: '11,920', x: 19 },
    { text: '-33.5', x: 20 },
  ];

  it('keeps dash positions as 0 instead of shifting columns', () => {
    expect(rowNumbersFromItems(romaniaItems, ['Romania'])).toEqual([
      974, 1164, 0, 0, 4642, 5284, 489, 1511, 1280, 3002, 542, 959, 7927, 11920,
    ]);
  });

  it('maps a dashed-PHEV row to PHEV=0 and HYBRID=4642, not the reverse', () => {
    const numbers = rowNumbersFromItems(romaniaItems, ['Romania']);
    expect(numbers.length).toBeGreaterThanOrEqual(14);
    expect({ phev: numbers[2], hybrid: numbers[4] }).toEqual({ phev: 0, hybrid: 4642 });
  });

  it('leaves a complete row untouched (no spurious zeros)', () => {
    const items = [
      { text: 'Spain', x: 0 },
      { text: '3375', x: 1 },
      { text: '3012', x: 2 },
      { text: '+11.0', x: 3 },
      { text: '4578', x: 4 },
      { text: '4102', x: 5 },
      { text: 'France 2500', x: 6 },
    ];
    expect(rowNumbersFromItems(items, ['Spain', 'France'])).toEqual([3375, 3012, 4578, 4102, 2500]);
  });
});

describe('ACEA data-row discrimination (prose vs table)', () => {
  it('rejects the press-prose false match from the April 2024 PDF', () => {
    // Exact items that aborted the ES recollect: sentence fragment with
    // 4 stray numbers, matched "Spain" under the old >= 4 rule.
    const prose = [
      { text: '91', x: 0 },
      { text: '3', x: 1 },
      { text: ',9', x: 2 },
      { text: '95', x: 3 },
      {
        text: 'units, driven by strong increases across all major markets: Spain (+23.1%),',
        x: 4,
      },
    ];
    expect(isMonthlyDataRow(prose, ['Spain', 'SPAIN'])).toBe(false);
  });

  it('accepts a genuine 14-number data row', () => {
    const row = [
      { text: 'Spain', x: 0 },
      { text: '3375', x: 1 },
      { text: '3012', x: 2 },
      { text: '4578', x: 3 },
      { text: '4102', x: 4 },
      { text: '26451', x: 5 },
      { text: '25010', x: 6 },
      { text: '2762', x: 7 },
      { text: '2544', x: 8 },
      { text: '23966', x: 9 },
      { text: '23120', x: 10 },
      { text: '7553', x: 11 },
      { text: '7010', x: 12 },
      { text: '68685', x: 13 },
      { text: '65432', x: 14 },
    ];
    expect(isMonthlyDataRow(row, ['Spain', 'SPAIN'])).toBe(true);
  });
});

describe('ACEA plausibility guard', () => {
  it('accepts legitimate monthly totals', () => {
    const rows = [
      { energie: 'BEV', total: 3375 },
      { energie: 'PHEV', total: 4578 },
      { energie: 'HYBRID', total: 26451 },
      { energie: 'DIESEL', total: 7553 },
      { energie: 'GASOLINE', total: 23966 },
      { energie: 'OTHER', total: 2762 },
    ];
    expect(() => assertPlausibleAceaData(rows, 'ES')).not.toThrow();
  });

  it('rejects the mid-2025 percentage-fragment mis-parses (ES/IT)', () => {
    // Exact vectors persisted in data/ES and data/IT for 2025-06.
    const corrupt = [
      { energie: 'BEV', total: 3 },
      { energie: 'PHEV', total: 7 },
      { energie: 'HYBRID', total: 0 },
      { energie: 'DIESEL', total: 2 },
      { energie: 'GASOLINE', total: 1 },
      { energie: 'OTHER', total: 7 },
    ];
    expect(() => assertPlausibleAceaData(corrupt, 'ES')).toThrow(/implausible/i);
  });
});
