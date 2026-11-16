import { api } from '../../services/apiClient.js';

// Subscriptions API. Costs shown as "estimate" are normalised from billing cycles by the server; "actual" payments are renewals the
// user confirmed (or opted into auto-recording). A renewal date arriving never marks anything as paid.
export const listSubscriptions = (status = 'all', days = 30) => api.get('/subscriptions', { status, days }).then((r) => r.data.subscriptions);
export const getSubscriptionSummary = (days = 30) => api.get('/subscriptions/summary', { days }).then((r) => r.data);
export const getSubscription = (id) => api.get(`/subscriptions/${id}`).then((r) => r.data.subscription);
export const createSubscription = (payload) => api.post('/subscriptions', payload).then((r) => r.data); // { subscription, warnings }
export const updateSubscription = (id, payload) => api.put(`/subscriptions/${id}`, payload).then((r) => r.data.subscription);
export const deleteSubscription = (id) => api.del(`/subscriptions/${id}`);
export const pauseSubscription = (id) => api.post(`/subscriptions/${id}/pause`).then((r) => r.data.subscription);
export const resumeSubscription = (id) => api.post(`/subscriptions/${id}/resume`).then((r) => r.data.subscription);
export const cancelSubscription = (id) => api.post(`/subscriptions/${id}/cancel`).then((r) => r.data.subscription);
export const recordPayment = (id, payload) => api.post(`/subscriptions/${id}/payments`, payload).then((r) => r.data);

export const CATEGORIES = ['Entertainment', 'Software', 'Education', 'Cloud Services', 'Productivity', 'Other'];
export const CURRENCIES = ['BDT', 'USD', 'EUR', 'GBP', 'INR'];
export const FREQUENCIES = [['WEEKLY', 'Weekly'], ['MONTHLY', 'Monthly'], ['QUARTERLY', 'Quarterly (every 3 months)'], ['YEARLY', 'Yearly'], ['CUSTOM', 'Custom interval (days)']];
export const frequencyLabel = (s) => ({ WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', YEARLY: 'Yearly' }[s.frequency] || `Every ${s.customIntervalDays} days`);
export const moneyIn = (amount, currency = 'BDT') => {
  const n = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency === 'BDT' ? `৳${n}` : `${currency} ${n}`;
};
