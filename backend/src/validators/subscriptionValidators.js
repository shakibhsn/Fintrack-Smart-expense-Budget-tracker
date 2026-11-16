const { z } = require('zod');
const { numIn, dateIn, cents, CENTS_MESSAGE } = require('./scalar');
const { CATEGORIES, FREQUENCIES } = require('../utils/subscriptionMath');

const date = dateIn('Invalid date').pipe(z.coerce.date({ error: 'Invalid date' })
  .refine((d) => d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100, 'Date must be between 2000 and 2100'));
const text = (max) => z.string().trim().max(max, `Must be ${max} characters or fewer`);
const optionalText = (max) => text(max).nullable().optional().transform((v) => (v ? v : null));
// For UPDATES an omitted field must stay omitted (the transform above would turn it into null and wipe the stored value).
// '' or null clear the field explicitly; the service maps '' to null.
const optionalTextUpdate = (max) => text(max).nullable().optional();

const fields = {
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or fewer'),
  provider: optionalText(100),
  category: z.enum(CATEGORIES, { error: `Category must be one of: ${CATEGORIES.join(', ')}` }),
  amount: numIn.pipe(z.coerce.number({ error: 'Amount must be a number' }).positive('Amount must be greater than 0').max(999999999.99, 'Amount is too large').refine(cents, CENTS_MESSAGE)),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter code such as BDT or USD'),
  frequency: z.enum(FREQUENCIES, { error: `Billing frequency must be one of: ${FREQUENCIES.join(', ')}` }),
  customIntervalDays: z.coerce.number().int('Custom interval must be a whole number of days').min(1, 'Custom interval must be at least 1 day').max(3650, 'Custom interval is too long').nullable().optional(),
  startDate: date,
  nextRenewalDate: date.nullable().optional(),
  endDate: date.nullable().optional(),
  paymentMethod: optionalText(60),
  notes: optionalText(500),
  autoRecord: z.boolean().optional(),
  reminderDays: z.coerce.number().int().min(0, 'Reminder days cannot be negative').max(60, 'Reminder can be at most 60 days ahead').nullable().optional(),
};

const customNeedsInterval = (o) => o.frequency !== 'CUSTOM' || o.customIntervalDays;
const datesOrdered = (o) => !o.endDate || !o.startDate || o.endDate >= o.startDate;
const renewalNotBeforeStart = (o) => !o.nextRenewalDate || !o.startDate || o.nextRenewalDate >= o.startDate;
const customMsg = { message: 'Custom billing needs the interval in days', path: ['customIntervalDays'] };
const dateMsg = { message: 'End date must be on or after the start date', path: ['endDate'] };
const renewalMsg = { message: 'The next renewal cannot be before the start date', path: ['nextRenewalDate'] };

const createSubscriptionSchema = z.object({ ...fields, currency: fields.currency.optional() }).strict()
  .refine(customNeedsInterval, customMsg).refine(datesOrdered, dateMsg).refine(renewalNotBeforeStart, renewalMsg);

const updateSubscriptionSchema = z.object({
  name: fields.name.optional(), provider: optionalTextUpdate(100), category: fields.category.optional(), amount: fields.amount.optional(),
  currency: fields.currency.optional(), frequency: fields.frequency.optional(), customIntervalDays: fields.customIntervalDays,
  startDate: fields.startDate.optional(), nextRenewalDate: fields.nextRenewalDate, endDate: fields.endDate,
  paymentMethod: optionalTextUpdate(60), notes: optionalTextUpdate(500), autoRecord: fields.autoRecord, reminderDays: fields.reminderDays,
}).strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' })
  .refine(datesOrdered, dateMsg);

const paymentSchema = z.object({
  paidDate: date.optional(),
  recordTransaction: z.boolean().optional(),
}).strict();

const listQuerySchema = z.object({
  status: z.enum(['all', 'upcoming', 'active', 'paused', 'cancelled', 'expired']).default('all'),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

module.exports = { createSubscriptionSchema, updateSubscriptionSchema, paymentSchema, listQuerySchema };
