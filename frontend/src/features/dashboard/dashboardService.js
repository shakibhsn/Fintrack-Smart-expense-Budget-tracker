import { api } from '../../services/apiClient.js';

// GET /api/dashboard?period=month|last_month|year -> { summary, monthlyIncomeExpense, categoryExpenses, recentTransactions }
// Several dashboard widgets ask for this at once; apiClient shares one in-flight request between them.
export const getDashboardOverview = (period = 'month') => api.get('/dashboard', { period }).then((r) => r.data);
