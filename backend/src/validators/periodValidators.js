const { z } = require('zod');

// Used by GET /api/dashboard - matches the frontend's period selector.
const dashboardQuerySchema = z.object({
  period: z.enum(['month', 'last_month', 'year']).default('month'),
});

const monthlyQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

const month = z.coerce.number().int().min(1).max(12);
const year = z.coerce.number().int().min(2000).max(2100);

const categoryQuerySchema = z.object({
  month: month.default(() => new Date().getUTCMonth() + 1),
  year: year.default(() => new Date().getUTCFullYear()),
});

module.exports = { dashboardQuerySchema, monthlyQuerySchema, categoryQuerySchema };
