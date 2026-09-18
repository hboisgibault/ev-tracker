import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseKbaExcel, getKbaFileUrls } = require('../scripts/parsers/DE.js');

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('KBA Excel parsing', () => {
  it('extracts fuel totals from the FZ10 fixture', () => {
    const buffer = readFileSync(join(fixturesDir, 'kba-sample.xlsx'));
    expect(parseKbaExcel(buffer)).toEqual({
      BEV: 300,
      DIESEL: 200,
      PHEV: 100,
      HYBRID: 150,
      GASOLINE: 250, // 1000 - 200 - 250 (all hybrids) - 300
    });
  });

  it('returns null when the total row is missing', () => {
    const xlsx = require('@e965/xlsx');
    const wb = xlsx.utils.book_new();
    wb.SheetNames.push('FZ10.1');
    wb.Sheets['FZ10.1'] = xlsx.utils.aoa_to_sheet([['Insgesamt', 'mit Dieselantrieb']]);
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    expect(parseKbaExcel(buffer)).toBeNull();
  });

  it('targets the FZ10/FZ7 file patterns', () => {
    const urls = getKbaFileUrls(2025, 6);
    expect(urls.some((u) => u.includes('fz10_2025_06'))).toBe(true);
  });
});
