const { z } = require('zod');

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or fewer'),
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254, 'Email is too long'),
  // bcrypt only uses the first 72 BYTES: longer passwords would be silently truncated, so they are refused instead
  password: z.string().min(8, 'Password must be at least 8 characters').refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes (about 72 characters)'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: z.string().min(1, 'Password is required').max(200, 'Password is too long'), // existing accounts with older, shorter passwords can still sign in
});

module.exports = { registerSchema, loginSchema };
