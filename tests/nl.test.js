import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapFuelType, saveMonthlyData } = require('../scripts/parsers/NL.js');

describe('mapFuelType (NL/RDW)', () => {
  it.each([
    ['Elektriciteit', 'BEV'],
    ['Benzine', 'GASOLINE'],
    ['Diesel', 'DIESEL'],
    ['LPG', 'OTHER'],
    ['CNG', 'OTHER'],
    ['Waterstof', 'OTHER'],
  ])('maps %s to %s', (brandstof, expected) => {
    expect(mapFuelType(brandstof)).toBe(expected);
  });

  it('falls back to OTHER for unknown descriptions', () => {
    expect(mapFuelType('Hybride')).toBe('OTHER');
    expect(mapFuelType(undefined)).toBe('OTHER');
  });
});

describe('saveMonthlyData (NL/RDW)', () => {
  it('refuses partial months instead of persisting them (2026-02/03 case)', () => {
    // Exact 2026-02 vector once persisted with 659 vehicles (~25 000 expected).
    expect(() => saveMonthlyData('2026-02', { BEV: 380, GASOLINE: 274, DIESEL: 5 })).toThrow(
      /implausible/i
    );
    expect(() => saveMonthlyData('2026-03', { BEV: 1 })).toThrow(/implausible/i);
  });
});
