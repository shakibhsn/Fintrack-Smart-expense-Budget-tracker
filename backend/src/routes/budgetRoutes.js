const express = require('express');
const c = require('../controllers/budgetController');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validationMiddleware');
const { budgetSchema, updateBudgetSchema } = require('../validators/budgetValidators');

const router = express.Router();
router.use(protect);

router.get('/summary', c.getSummary); // keep before any '/:id' route
router.get('/', c.getBudgets);
router.post('/', validate(budgetSchema), c.createBudget);
router.put('/:id', validate(updateBudgetSchema), c.updateBudget);
router.delete('/:id', c.deleteBudget);

module.exports = router;
