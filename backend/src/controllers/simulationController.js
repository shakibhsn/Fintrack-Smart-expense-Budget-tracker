const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/simulationService');
const { calculateSchema, saveSchema, baselineQuerySchema } = require('../validators/simulationValidators');

// None of these handlers writes to Transaction, Budget or SavingsGoal. Only SavedSimulation is written (save/delete).

// GET /api/simulations/baseline?months=3 - the user's real monthly averages the simulator starts from
const baseline = asyncHandler(async (req, res) => {
  const { months } = baselineQuerySchema.parse(req.query);
  res.json({ success: true, data: await svc.getBaseline(req.user.id, months) });
});

// POST /api/simulations/calculate { inputs, months? } - stateless, nothing stored
const calculate = asyncHandler(async (req, res) => {
  const { inputs, months } = calculateSchema.parse(req.body);
  res.json({ success: true, data: await svc.calculate(req.user.id, inputs, months) });
});

// GET /api/simulations
const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { simulations: await svc.list(req.user.id) } });
});

// POST /api/simulations { name, inputs, months? }
const create = asyncHandler(async (req, res) => {
  const { name, inputs, months } = saveSchema.parse(req.body);
  res.status(201).json({ success: true, data: { simulation: await svc.save(req.user.id, name, inputs, months) } });
});

// GET /api/simulations/:id - saved result + the same scenario recalculated against today's data
const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { simulation: await svc.get(req.user.id, req.params.id) } });
});

// DELETE /api/simulations/:id
const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.user.id, req.params.id);
  res.json({ success: true, message: 'Simulation deleted' });
});

module.exports = { baseline, calculate, list, create, getOne, remove };
