const express = require('express');
const c = require('../controllers/goalController');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validationMiddleware');
const { goalSchema, updateGoalSchema, contributionSchema } = require('../validators/goalValidators');

const router = express.Router();
router.use(protect);

router.get('/summary', c.getSummary); // keep before '/:id'
router.get('/', c.getGoals);
router.post('/', validate(goalSchema), c.createGoal);
router.get('/:id', c.getGoal);
router.put('/:id', validate(updateGoalSchema), c.updateGoal);
router.delete('/:id', c.deleteGoal);
router.get('/:id/contributions', c.getContributions);
router.post('/:id/contributions', validate(contributionSchema), c.createContribution);
router.post('/:id/deposit', validate(contributionSchema), c.createContribution); // legacy alias

module.exports = router;
