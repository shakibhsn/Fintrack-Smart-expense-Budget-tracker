const express = require('express');
const c = require('../controllers/simulationController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.get('/baseline', c.baseline);
router.post('/calculate', c.calculate);
router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.getOne);
router.delete('/:id', c.remove);

module.exports = router;
