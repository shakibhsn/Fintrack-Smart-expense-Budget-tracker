// Spending health tiers from the server's percentage: 0-69 healthy, 70-89 warning, 90-100 critical, >100 over budget.
// Each tier has a TEXT label as well as a colour, so meaning never depends on colour alone.
export const tierOf = (b) => (b.isOverBudget ? 'over' : b.percentage >= 90 ? 'critical' : b.percentage >= 70 ? 'warning' : 'healthy');
export const TIERS = {
  healthy: { label: 'Healthy', tone: 'brand', bar: '' },
  warning: { label: 'Warning', tone: 'warning', bar: 'warning' },
  critical: { label: 'Critical', tone: 'warning', bar: 'warning' },
  over: { label: 'Over budget', tone: 'danger', bar: 'danger' },
};
