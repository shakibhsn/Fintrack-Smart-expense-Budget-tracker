const { z } = require('zod');

// `z.coerce.number()` / `z.coerce.date()` turn almost anything into a value: [1] becomes 1, null becomes the 1970 epoch, "2023-02-31" silently becomes
// 3 March. These two guards run BEFORE the coercion so that only a number / a non-empty string can be a number, and only a REAL calendar day can be a date.

// number input: a JSON number or a non-empty string (arrays, objects, booleans and null are refused); the coercion that follows rejects non-numeric text
const numIn = z.union([z.number(), z.string().trim().min(1)], { error: 'Must be a number' });

const validDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return false;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso; // 2023-02-31 would roll over to March: refused
};

// date input: a string that starts with a real YYYY-MM-DD day (an ISO date-time such as 2025-01-31T00:00:00.000Z is fine)
const dateIn = (message = 'Invalid date') => z.string({ error: message }).refine(validDay, message);

// at most two decimal places (cents): used on every money field
const cents = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;
const CENTS_MESSAGE = 'Amounts can have at most 2 decimal places';

module.exports = { numIn, dateIn, validDay, cents, CENTS_MESSAGE };
