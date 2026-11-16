const { z } = require('zod');

const category = z.string().trim().min(1).max(50);
const money = z.coerce.number({ error: 'Must be a number' }).finite().min(0, 'Must be 0 or more').max(999999999.99, 'Value is too large');

const inputsSchema = z.object({
  categoryReductions: z.record(category, z.coerce.number().finite().min(0, 'A reduction must be between 0 and 100%').max(100, 'A reduction must be between 0 and 100%')).default({}),
  incomeIncrease: money.default(0),
  savingsTargetPct: z.coerce.number().finite().min(0, 'Target must be between 0 and 100%').max(100, 'Target must be between 0 and 100%').nullable().optional(),
  budgetAdjustments: z.record(category, money).default({}),
}).strict().refine(
  (o) => Object.keys(o.categoryReductions).length <= 50 && Object.keys(o.budgetAdjustments).length <= 50,
  { message: 'Too many categories' }
);

const months = z.coerce.number().int().min(1).max(12).default(3);

const calculateSchema = z.object({ inputs: inputsSchema, months }).strict();
const saveSchema = z.object({
  name: z.string().trim().min(1, 'Scenario name is required').max(100, 'Scenario name must be 100 characters or fewer'),
  inputs: inputsSchema,
  months,
}).strict();
const baselineQuerySchema = z.object({ months });

module.exports = { calculateSchema, saveSchema, baselineQuerySchema };
