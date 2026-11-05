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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');

// GET /api/analytics/overview - custom needs both dates, end >= start, at most 5 years.
const overviewQuerySchema = z.object({
  period: z.enum(['this_month', 'last_month', 'last_3_months', 'last_6_months', 'this_year', 'custom']).default('this_month'),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
}).superRefine((q, ctx) => {
  if (q.period !== 'custom') return;
  if (!q.startDate || !q.endDate) {
    ctx.addIssue({ code: 'custom', message: 'Custom range needs both startDate and endDate', path: ['startDate'] });
  } else if (q.endDate < q.startDate) {
    ctx.addIssue({ code: 'custom', message: 'End date must be on or after the start date', path: ['endDate'] });
  } else if ((q.endDate - q.startDate) / 86400000 > 366 * 5) {
    ctx.addIssue({ code: 'custom', message: 'Custom range cannot exceed 5 years', path: ['endDate'] });
  }
});

module.exports = { dashboardQuerySchema, monthlyQuerySchema, categoryQuerySchema, overviewQuerySchema };
