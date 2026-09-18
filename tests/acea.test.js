import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parsePdfData,
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
