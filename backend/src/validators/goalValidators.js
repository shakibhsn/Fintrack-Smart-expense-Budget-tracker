const { z } = require('zod');

const money = (label) => z.coerce.number({ invalid_type_error: `${label} must be a number` })
  .max(999999999.99, `${label} is too large`);

const isoDay = (v) => new Date(`${v}T00:00:00.000Z`);
const todayUtc = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };

// YYYY-MM-DD (or empty/null = "no value")
const optionalDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? isoDay(v) : v === undefined ? undefined : null))
  .refine((d) => d === undefined || d === null || !Number.isNaN(d.getTime()), 'Invalid date');

const optionalText = (max) => z.string().trim().max(max).optional().nullable()
  .transform((v) => (v ? v : v === undefined ? undefined : null));

const baseGoal = {
  title: z.string().trim().min(1, 'Title is required').max(100),
  targetAmount: money('Target amount').positive('Target amount must be greater than 0'),
  targetDate: optionalDate,
  category: optionalText(50),
  description: optionalText(500),
  icon: z.string().trim().min(1).max(50).default('fa-piggy-bank'),
};

// Create: optional starting balance (stored as the goal's first contribution).
const goalSchema = z.object({
  ...baseGoal,
  savedAmount: money('Saved amount').min(0, 'Saved amount cannot be negative').default(0),
}).superRefine((g, ctx) => {
  if (g.savedAmount > g.targetAmount) {
    ctx.addIssue({ code: 'custom', path: ['savedAmount'], message: 'Initial saved amount cannot be more than the target amount' });
  }
  if (g.targetDate && g.targetDate < todayUtc()) {
    ctx.addIssue({ code: 'custom', path: ['targetDate'], message: 'Target date cannot be in the past' });
  }
});

// Update: saved money can only change through contributions, so savedAmount is not accepted here.
const updateGoalSchema = z.object({
  title: baseGoal.title.optional(),
  targetAmount: baseGoal.targetAmount.optional(),
  targetDate: baseGoal.targetDate,
  category: baseGoal.category,
  description: baseGoal.description,
  icon: z.string().trim().min(1).max(50).optional(),
}).strict().transform((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)))
  .refine((obj) => Object.keys(obj).length > 0, { message: 'Provide at least one field to update' });

const contributionSchema = z.object({
  amount: money('Amount').positive('Contribution must be greater than 0'),
  date: optionalDate,
  note: optionalText(200),
}).superRefine((c, ctx) => {
  if (c.date && c.date > todayUtc()) ctx.addIssue({ code: 'custom', path: ['date'], message: 'Contribution date cannot be in the future' });
});

module.exports = { goalSchema, updateGoalSchema, contributionSchema, depositSchema: contributionSchema };
