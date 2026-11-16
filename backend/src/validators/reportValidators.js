const { z } = require('zod');
const { overviewQuerySchema } = require('./periodValidators');

// Same periods and the same custom-range rules as Analytics, so a report and the Analytics page always describe the same range.
const reportQuerySchema = overviewQuerySchema;

const snapshotBodySchema = z.object({
  period: z.enum(['this_month', 'last_month', 'last_3_months', 'last_6_months', 'this_year', 'custom']).default('this_month'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  title: z.string().trim().max(100, 'Title can be at most 100 characters').optional(),
}).strict();

module.exports = { reportQuerySchema, snapshotBodySchema };
