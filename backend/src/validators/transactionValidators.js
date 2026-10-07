const { z } = require('zod');

const amount = z.coerce.number({ invalid_type_error: 'Amount must be a number' })
  .positive('Amount must be greater than 0')
  .max(999999999.99, 'Amount is too large');

const notes = z.string().trim().max(500, 'Notes must be 500 characters or fewer').optional()
  .transform((v) => (v ? v : null));

const transactionSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE'], { errorMap: () => ({ message: 'Type must be INCOME or EXPENSE' }) }),
  amount,
  category: z.string().trim().min(1, 'Category is required').max(50),
  description: z.string().trim().min(1, 'Description is required').max(200),
  notes,
  date: z.coerce.date({ errorMap: () => ({ message: 'Invalid date' }) }),
});

// PUT allows partial updates
const updateTransactionSchema = transactionSchema.partial().refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'Provide at least one field to update' }
);

// Query string for GET /api/transactions
const listQuerySchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  category: z.string().trim().min(1).optional(),
  search: z.string().trim().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  minAmount: z.coerce.number().min(0).optional(),
  maxAmount: z.coerce.number().min(0).optional(),
  sort: z.enum(['date-desc', 'date-asc', 'amount-desc', 'amount-asc']).default('date-desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).refine((obj) => !(obj.dateFrom && obj.dateTo) || obj.dateTo >= obj.dateFrom, {
  message: 'dateTo must be on or after dateFrom',
  path: ['dateTo'],
}).refine((obj) => !(obj.minAmount !== undefined && obj.maxAmount !== undefined) || obj.maxAmount >= obj.minAmount, {
  message: 'maxAmount must be greater than or equal to minAmount',
  path: ['maxAmount'],
});

module.exports = { transactionSchema, updateTransactionSchema, listQuerySchema };
