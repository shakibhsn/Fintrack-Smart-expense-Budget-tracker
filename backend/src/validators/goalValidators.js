const { z } = require('zod');

const money = (label) => z.coerce.number({ invalid_type_error: `${label} must be a number` })
  .max(999999999.99, `${label} is too large`);

const goalSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(100),
  targetAmount: money('Target amount').positive('Target amount must be greater than 0'),
  savedAmount: money('Saved amount').min(0, 'Saved amount cannot be negative').default(0),
  icon: z.string().trim().min(1).max(50).default('fa-piggy-bank'),
});

const updateGoalSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  targetAmount: money('Target amount').positive('Target amount must be greater than 0').optional(),
  savedAmount: money('Saved amount').min(0, 'Saved amount cannot be negative').optional(),
  icon: z.string().trim().min(1).max(50).optional(),
}).refine((obj) => Object.keys(obj).length > 0, { message: 'Provide at least one field to update' });

const depositSchema = z.object({
  amount: money('Amount').positive('Deposit must be greater than 0'),
});

module.exports = { goalSchema, updateGoalSchema, depositSchema };
