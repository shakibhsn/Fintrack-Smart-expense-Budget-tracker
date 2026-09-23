const express = require('express');
const c = require('../controllers/transactionController');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validationMiddleware');
const { transactionSchema, updateTransactionSchema } = require('../validators/transactionValidators');

const router = express.Router();
router.use(protect); // every transaction route requires login

router.get('/', c.getTransactions);
router.post('/', validate(transactionSchema), c.createTransaction);
router.get('/:id', c.getTransaction);
router.put('/:id', validate(updateTransactionSchema), c.updateTransaction);
router.delete('/:id', c.deleteTransaction);

module.exports = router;
