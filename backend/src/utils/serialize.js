// Prisma returns Decimal objects for money columns. The frontend wants plain numbers,
// and dates as YYYY-MM-DD strings, so we convert here in one place.
const toNumber = (value) => (value === null || value === undefined ? value : Number(value));

const serializeTransaction = (tx) => ({
  id: tx.id,
  type: tx.type,
  amount: toNumber(tx.amount),
  category: tx.category,
  description: tx.description,
  date: tx.date.toISOString().slice(0, 10),
  createdAt: tx.createdAt,
  updatedAt: tx.updatedAt,
});

const serializeGoal = (goal) => {
  const targetAmount = toNumber(goal.targetAmount);
  const savedAmount = toNumber(goal.savedAmount);
  const progress = targetAmount > 0 ? Math.round((savedAmount / targetAmount) * 1000) / 10 : 0;
  return {
    id: goal.id,
    title: goal.title,
    targetAmount,
    savedAmount,
    remaining: Math.max(targetAmount - savedAmount, 0),
    progress: Math.min(progress, 100),
    icon: goal.icon,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
};

module.exports = { toNumber, serializeTransaction, serializeGoal };
