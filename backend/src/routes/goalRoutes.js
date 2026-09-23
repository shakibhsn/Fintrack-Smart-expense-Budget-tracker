const express = require('express');
const c = require('../controllers/goalController');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validationMiddleware');
const { goalSchema, updateGoalSchema, depositSchema } = require('../validators/goalValidators');

const router = express.Router();
router.use(protect);

router.get('/', c.getGoals);
router.post('/', validate(goalSchema), c.createGoal);
router.get('/:id', c.getGoal);
router.put('/:id', validate(updateGoalSchema), c.updateGoal);
router.delete('/:id', c.deleteGoal);
router.post('/:id/deposit', validate(depositSchema), c.depositToGoal);

module.exports = router;
