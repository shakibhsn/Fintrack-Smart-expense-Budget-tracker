const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const ai = require('../services/ai/assistantService');
const recs = require('../services/ai/recommendationService');
const { rangeSchema } = require('../services/ai/tools');

const askBody = z.object({ question: z.string().max(ai.MAX_QUESTION + 100), range: rangeSchema.optional() }).strict();
const settingsBody = z.object({ enabled: z.boolean().optional(), externalAi: z.boolean().optional() }).strict().refine((o) => Object.keys(o).length > 0, { message: 'Provide a setting to change' });
const dismissBody = z.object({ key: z.string().min(3).max(120) }).strict();

const status = asyncHandler(async (req, res) => res.json({ success: true, data: await ai.status(req.user.id) }));
const putSettings = asyncHandler(async (req, res) => res.json({ success: true, data: { settings: await ai.updateSettings(req.user.id, settingsBody.parse(req.body || {})) } }));
const ask = asyncHandler(async (req, res) => { const b = askBody.parse(req.body || {}); res.json({ success: true, data: await ai.ask(req.user, b) }); });
const recommendations = asyncHandler(async (req, res) => res.json({ success: true, data: await ai.getRecommendations(req.user) }));
const dismiss = asyncHandler(async (req, res) => {
  const { key } = dismissBody.parse(req.body || {});
  if (!/^[a-z_]+:[^:]*:\d{4}-\d{2}$/.test(key)) throw httpError(400, 'Invalid recommendation key');
  await recs.dismiss(req.user.id, key);
  res.json({ success: true, message: 'Recommendation dismissed' });
});

module.exports = { status, putSettings, ask, recommendations, dismiss };
