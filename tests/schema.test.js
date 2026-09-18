import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateMonthlyOutput } = require('../scripts/schema.js');

const validOutput = {
  year: 2025,
  month: 6,
  sourceUrl: 'https://www.acea.auto/files/Press_release_car_registrations_June_2025.pdf',
  data: [
    { marque: 'Toutes marques', modele: 'Tous modèles', total: 3375, energie: 'BEV' },
    { marque: 'Toutes marques', modele: 'Tous modèles', total: 4578, energie: 'PHEV' },
  ],
};

describe('monthly output schema', () => {
  it('accepts a valid monthly file', () => {
    expect(() => validateMonthlyOutput(validOutput)).not.toThrow();
  });

  it('rejects negative totals', () => {
    const bad = {
      ...validOutput,
      data: [{ marque: 'a', modele: 'b', total: -5, energie: 'BEV' }],
    };
    expect(() => validateMonthlyOutput(bad)).toThrow();
  });

  it('rejects unknown fuel codes', () => {
    const bad = {
      ...validOutput,
      data: [{ marque: 'a', modele: 'b', total: 5, energie: 'ESSENCE' }],
    };
    expect(() => validateMonthlyOutput(bad)).toThrow();
  });

  it('rejects empty data and zero-sum files', () => {
    expect(() => validateMonthlyOutput({ ...validOutput, data: [] })).toThrow();
    const zeroSum = {
      ...validOutput,
      data: [{ marque: 'a', modele: 'b', total: 0, energie: 'BEV' }],
    };
    expect(() => validateMonthlyOutput(zeroSum)).toThrow();
  });

  it('rejects missing sourceUrl', () => {
    const { sourceUrl, ...bad } = validOutput;
    expect(() => validateMonthlyOutput(bad)).toThrow();
  });
});
