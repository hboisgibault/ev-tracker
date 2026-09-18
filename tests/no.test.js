import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseJsonStat, mapFuelType } = require('../scripts/parsers/NO.js');

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('SSB JSON-stat parsing', () => {
  it('maps the flat value array to fuel x month', () => {
    const response = JSON.parse(readFileSync(join(fixturesDir, 'ssb-sample.json'), 'utf8'));
    expect(parseJsonStat(response)).toEqual({
      '2024M01': { 19: 1200, 20: 300 },
      '2024M02': { 19: 900, 20: 150 },
    });
  });

  it('rejects malformed responses', () => {
    expect(() => parseJsonStat({})).toThrow(/invalid json-stat/i);
  });
});

describe('mapFuelType (NO)', () => {
  it.each([
    ['19', 'BEV'],
    ['20', 'FOSSIL'],
    ['21', 'HYBRID'],
    ['6', 'OTHER'],
    ['999', 'UNKNOWN'],
  ])('maps %s to %s', (code, expected) => {
    expect(mapFuelType(code)).toBe(expected);
  });
});
