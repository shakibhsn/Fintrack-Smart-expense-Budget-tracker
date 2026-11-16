import { api } from '../../services/apiClient.js';

// Budgets API. /budgets/summary returns every budget (with spent/remaining/percentage computed by the server from real
// transactions) plus totals across the budgets that are active right now.
export const getBudgetSummary = () => api.get('/budgets/summary').then((r) => r.data);
export const createBudget = (payload) => api.post('/budgets', payload).then((r) => r.data.budget);
export const updateBudget = (id, payload) => api.put(`/budgets/${id}`, payload).then((r) => r.data.budget);
export const deleteBudget = (id) => api.del(`/budgets/${id}`);
