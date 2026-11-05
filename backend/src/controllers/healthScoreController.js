const asyncHandler = require('../utils/asyncHandler');
const { getHealthScore } = require('../services/healthScoreService');

// GET /api/health-score - score, breakdown, strengths/improvements and history for the logged-in user
const getScore = asyncHandler(async (req, res) => {
  const data = await getHealthScore(req.user.id);
  res.json({ success: true, data });
});

module.exports = { getScore };
