const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const { getForecast, PERIODS } = require('../services/forecastService');

const querySchema = z.object({
  period: z.enum(Object.keys(PERIODS), {
    error: `period must be one of: ${Object.keys(PERIODS).join(', ')}`,
  }).default('next_30_days'),
});

// GET /api/forecast?period=next_7_days|next_30_days|next_3_months|next_6_months
// Calculated from the logged-in user's own transactions; cached until their data changes.
const getUserForecast = asyncHandler(async (req, res) => {
  const { period } = querySchema.parse(req.query);
  const data = await getForecast(req.user.id, period);
  res.json({ success: true, data });
});

module.exports = { getUserForecast };
