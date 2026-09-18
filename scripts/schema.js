// scripts/schema.js
// JSON schema (zod) for monthly output files written by every parser.
// Every saveMonthlyData / write path must call validateMonthlyOutput()
// BEFORE fs.writeFileSync so a broken parser fails loudly instead of
// persisting garbage (cf. ACEA ES/IT micro-values of mid-2025).

const { z } = require('zod');

// Normalized fuel codes used across parsers.
const EnergieCode = z.enum([
  'BEV',
  'PHEV',
  'HYBRID',
  'DIESEL',
  'GASOLINE',
  'OTHER',
  'FOSSIL', // Norway SSB aggregates gasoline+diesel
  'UNKNOWN',
]);

const DataRow = z.object({
  marque: z.string().min(1),
  modele: z.string().min(1),
  total: z.number().int().nonnegative(),
  energie: EnergieCode,
});

const MonthlyOutput = z
  .object({
    year: z.number().int().min(1990).max(2100),
    month: z.number().int().min(1).max(12),
    sourceUrl: z.string().min(1),
    data: z.array(DataRow).min(1),
    region: z.string().optional(),
    type: z.string().optional(),
  })
  .refine((o) => o.data.reduce((sum, row) => sum + row.total, 0) > 0, {
    message: 'sum of data totals must be > 0',
  });

/**
 * Validate a monthly output object. Returns the parsed object.
 * @throws {z.ZodError} when the output does not match the schema.
 */
function validateMonthlyOutput(output) {
  return MonthlyOutput.parse(output);
}

module.exports = { validateMonthlyOutput, MonthlyOutput, EnergieCode };
