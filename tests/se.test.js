import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeSwedishFuel, groupSwedishRecords } = require('../scripts/parsers/SE.js');
const { parse } = require('csv-parse/sync');

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixtureRecords() {
  const csv = readFileSync(join(fixturesDir, 'scb-sample.csv'), 'utf8');
  return parse(csv, { columns: true, skip_empty_lines: true, trim: true });
}

describe('normalizeSwedishFuel', () => {
  it.each([
    ['electricity', 'BEV'],
    ['plug-in hybrid', 'PHEV'],
    ['electric hybrid', 'HYBRID'],
    ['diesel', 'DIESEL'],
    ['petrol', 'GASOLINE'],
    ['unknown fuel label', 'OTHER'],
  ])('maps %s to %s', (label, expected) => {
    expect(normalizeSwedishFuel(label)).toBe(expected);
  });
});

describe('SCB CSV fixture', () => {
  it('groups national data by month, excluding regions and OTHER fuels', () => {
    const monthly = groupSwedishRecords(fixtureRecords());
    expect(monthly['2024-01'].byFuel).toEqual({
      BEV: 1500,
      GASOLINE: 800,
      PHEV: 400,
      HYBRID: 600,
      DIESEL: 200,
    });
    expect(monthly['2024-02'].byFuel).toEqual({ BEV: 1600, GASOLINE: 850 });
  });
});
