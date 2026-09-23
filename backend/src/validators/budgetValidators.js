const { z } = require('zod');

const month = z.coerce.number().int().min(1, 'Month must be 1-12').max(12, 'Month must be 1-12');
const year = z.coerce.number().int().min(2000, 'Invalid year').max(2100, 'Invalid year');

const budgetSchema = z.object({
  category: z.string().trim().min(1, 'Category is required').max(50),
  limit: z.coerce.number({ invalid_type_error: 'Limit must be a number' })
    .positive('Limit must be greater than 0').max(999999999.99),
  // month/year default to the current month when omitted
  month: month.default(() => new Date().getUTCMonth() + 1),
  year: year.default(() => new Date().getUTCFullYear()),
});

const updateBudgetSchema = z.object({
  category: z.string().trim().min(1).max(50).optional(),
  limit: z.coerce.number().positive('Limit must be greater than 0').max(999999999.99).optional(),
  month: month.optional(),
  year: year.optional(),
}).refine((obj) => Object.keys(obj).length > 0, { message: 'Provide at least one field to update' });

const periodQuerySchema = z.object({
  month: month.default(() => new Date().getUTCMonth() + 1),
  year: year.default(() => new Date().getUTCFullYear()),
});

module.exports = { budgetSchema, updateBudgetSchema, periodQuerySchema };
