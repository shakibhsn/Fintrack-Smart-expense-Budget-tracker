const { z } = require('zod');
const { CATEGORIES } = require('../services/notificationService');

const listQuerySchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(['all', 'unread', 'read']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const readAllQuerySchema = z.object({ category: z.enum(CATEGORIES).optional() });

const preferencesSchema = z.object({
  budget: z.boolean().optional(), goals: z.boolean().optional(), subscriptions: z.boolean().optional(), recurring: z.boolean().optional(),
  unusualSpending: z.boolean().optional(), insights: z.boolean().optional(), system: z.boolean().optional(), emailEnabled: z.boolean().optional(),
  renewalReminderDays: z.coerce.number().int().min(0, 'Reminder days cannot be negative').max(60, 'Reminder can be at most 60 days ahead').optional(),
}).strict().refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one preference to update' });

module.exports = { listQuerySchema, readAllQuerySchema, preferencesSchema };
