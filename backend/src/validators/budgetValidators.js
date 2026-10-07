const { z } = require('zod');

const money = z.coerce.number({ invalid_type_error: 'Limit must be a number' })
  .positive('Limit must be greater than 0').max(999999999.99);

const budgetSchema = z.object({
  category: z.string().trim().min(1, 'Category is required').max(50),
  limit: money,
  startDate: z.coerce.date({ errorMap: () => ({ message: 'Invalid start date' }) }),
  endDate: z.coerce.date({ errorMap: () => ({ message: 'Invalid end date' }) }),
}).refine((obj) => obj.endDate >= obj.startDate, {
  message: 'End date must be on or after the start date',
  path: ['endDate'],
});

const updateBudgetSchema = z.object({
  category: z.string().trim().min(1).max(50).optional(),
  limit: money.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
})
  .refine((obj) => Object.keys(obj).length > 0, { message: 'Provide at least one field to update' })
  .refine((obj) => !(obj.startDate && obj.endDate) || obj.endDate >= obj.startDate, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  });

module.exports = { budgetSchema, updateBudgetSchema };
