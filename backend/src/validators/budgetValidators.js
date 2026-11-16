const { z } = require('zod');
const { numIn, dateIn, cents, CENTS_MESSAGE } = require('./scalar');

const money = numIn.pipe(z.coerce.number({ error: 'Limit must be a number' })
  .positive('Limit must be greater than 0').max(999999999.99).refine(cents, CENTS_MESSAGE));

const budgetSchema = z.object({
  category: z.string().trim().min(1, 'Category is required').max(50),
  limit: money,
  startDate: dateIn('Invalid start date').pipe(z.coerce.date({ error: 'Invalid start date' })),
  endDate: dateIn('Invalid end date').pipe(z.coerce.date({ error: 'Invalid end date' })),
}).refine((obj) => obj.endDate >= obj.startDate, {
  message: 'End date must be on or after the start date',
  path: ['endDate'],
});

const updateBudgetSchema = z.object({
  category: z.string().trim().min(1).max(50).optional(),
  limit: money.optional(),
  startDate: dateIn('Invalid start date').pipe(z.coerce.date()).optional(),
  endDate: dateIn('Invalid end date').pipe(z.coerce.date()).optional(),
})
  .refine((obj) => Object.keys(obj).length > 0, { message: 'Provide at least one field to update' })
  .refine((obj) => !(obj.startDate && obj.endDate) || obj.endDate >= obj.startDate, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  });

module.exports = { budgetSchema, updateBudgetSchema };
