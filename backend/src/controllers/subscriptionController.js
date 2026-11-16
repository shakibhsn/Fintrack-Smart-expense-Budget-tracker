const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/subscriptionService');
const { createSubscriptionSchema, updateSubscriptionSchema, paymentSchema, listQuerySchema } = require('../validators/subscriptionValidators');

// Every handler scopes by req.user.id: another user's subscription id is simply "not found" (404).

const list = asyncHandler(async (req, res) => {
  const q = listQuerySchema.parse(req.query);
  await svc.processUser(req.user.id); // opt-in auto-recording that is due (also run by the scheduler)
  res.json({ success: true, data: { subscriptions: await svc.list(req.user.id, q) } });
});
const summary = asyncHandler(async (req, res) => {
  const { days } = listQuerySchema.parse(req.query);
  await svc.processUser(req.user.id);
  res.json({ success: true, data: await svc.summary(req.user.id, { days }) });
});
const create = asyncHandler(async (req, res) => {
  const out = await svc.create(req.user.id, createSubscriptionSchema.parse(req.body));
  res.status(201).json({ success: true, data: out });
});
const getOne = asyncHandler(async (req, res) => res.json({ success: true, data: { subscription: await svc.get(req.user.id, req.params.id) } }));
const update = asyncHandler(async (req, res) => res.json({ success: true, data: { subscription: await svc.update(req.user.id, req.params.id, updateSubscriptionSchema.parse(req.body)) } }));
const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.user.id, req.params.id);
  res.json({ success: true, message: 'Subscription deleted. Expenses it recorded were kept.' });
});
const pause = asyncHandler(async (req, res) => res.json({ success: true, data: { subscription: await svc.pause(req.user.id, req.params.id) } }));
const resume = asyncHandler(async (req, res) => res.json({ success: true, data: { subscription: await svc.resume(req.user.id, req.params.id) } }));
const cancel = asyncHandler(async (req, res) => res.json({ success: true, data: { subscription: await svc.cancel(req.user.id, req.params.id) } }));
const pay = asyncHandler(async (req, res) => {
  const out = await svc.markPaid(req.user.id, req.params.id, paymentSchema.parse(req.body || {}));
  res.status(201).json({ success: true, data: out });
});
const processNow = asyncHandler(async (req, res) => res.json({ success: true, data: await svc.processUser(req.user.id) }));

module.exports = { list, summary, create, getOne, update, remove, pause, resume, cancel, pay, processNow };
