import { api } from '../../services/apiClient.js';

// Transactions API (feature-specific; shared HTTP concerns live in services/apiClient.js).
export const listTransactions = (params) => api.get('/transactions', params).then((r) => r.data); // { transactions, pagination }
export const getTransaction = (id) => api.get(`/transactions/${id}`).then((r) => r.data.transaction);
export const createTransaction = (payload) => api.post('/transactions', payload).then((r) => r.data.transaction);
export const updateTransaction = (id, payload) => api.put(`/transactions/${id}`, payload).then((r) => r.data.transaction);
export const deleteTransaction = (id) => api.del(`/transactions/${id}`);
// "This month" totals shown above the list (same numbers as the dashboard).
export const getMonthSummary = () => api.get('/dashboard', { period: 'month' }).then((r) => r.data.summary);
