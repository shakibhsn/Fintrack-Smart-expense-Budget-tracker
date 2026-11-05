const asyncHandler = require('../utils/asyncHandler');
const { getInsights } = require('../services/insightService');

// GET /api/insights - rule-based insights for the logged-in user (cached until their data changes)
const getUserInsights = asyncHandler(async (req, res) => {
  const data = await getInsights(req.user.id);
  res.json({ success: true, data });
});

module.exports = { getUserInsights };
