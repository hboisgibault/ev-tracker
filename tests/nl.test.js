import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapFuelType } = require('../scripts/parsers/NL.js');

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
