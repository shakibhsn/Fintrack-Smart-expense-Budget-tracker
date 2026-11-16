const { z } = require('zod');
const { numIn, dateIn, cents, CENTS_MESSAGE } = require('./scalar');
const { FREQUENCIES } = require('../utils/recurrence');

const amount = numIn.pipe(z.coerce.number({ error: 'Amount must be a number' })
  .positive('Amount must be greater than 0')
  .max(999999999.99, 'Amount is too large')
  .refine(cents, CENTS_MESSAGE));

const date = dateIn('Invalid date').pipe(z.coerce.date({ error: 'Invalid date' })
  .refine((d) => d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100, 'Date must be between 2000 and 2100'));

const fields = {
  title: z.string().trim().min(1, 'Title is required').max(100, 'Title must be 100 characters or fewer'),
  type: z.enum(['INCOME', 'EXPENSE'], { error: 'Type must be INCOME or EXPENSE' }),
  amount,
  category: z.string().trim().min(1, 'Category is required').max(50),
  notes: z.string().trim().max(500, 'Notes must be 500 characters or fewer').nullable().optional().transform((v) => (v ? v : null)),
  frequency: z.enum(FREQUENCIES, { error: `Frequency must be one of: ${FREQUENCIES.join(', ')}` }),
  startDate: date,
  endDate: date.nullable().optional(),
};

// For updates, an omitted notes field must stay omitted (the create-time transform would turn it into null
// and silently wipe existing notes). '' or null clear the notes explicitly.
const notesUpdate = z.string().trim().max(500, 'Notes must be 500 characters or fewer').nullable().optional();

const endAfterStart = (o) => !o.endDate || !o.startDate || o.endDate >= o.startDate;
const endMsg = { message: 'End date must be on or after the start date', path: ['endDate'] };

const createRecurringSchema = z.object({ ...fields, backfill: z.boolean().optional() }).strict().refine(endAfterStart, endMsg);

// applyTo exists so the choice is explicit in the API. Only "future" is supported (see backend README).
const updateRecurringSchema = z.object({
  title: fields.title.optional(),
  type: fields.type.optional(),
  amount: fields.amount.optional(),
  category: fields.category.optional(),
  notes: notesUpdate,
  frequency: fields.frequency.optional(),
  startDate: fields.startDate.optional(),
  endDate: fields.endDate,
  applyTo: z.literal('future', {
    error: "Only applyTo: 'future' is supported. Changes apply to occurrences that have not been generated yet; transactions that were already generated are never modified.",
  }).optional(),
}).strict()
  .refine((o) => Object.keys(o).filter((k) => k !== 'applyTo').length > 0, { message: 'Provide at least one field to update' })
  .refine(endAfterStart, endMsg);

const resumeSchema = z.object({ catchUp: z.boolean().optional() }).strict();

module.exports = { createRecurringSchema, updateRecurringSchema, resumeSchema };
