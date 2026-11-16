import { api } from './apiClient.js';

// Shared by the top-bar bell (shell) and the Notification Center page.
export const getNotifications = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== 'all')).toString();
  return api.get(`/notifications${q ? `?${q}` : ''}`).then((r) => r.data); // { notifications, unreadCount, unreadByCategory, pagination }
};
export const markRead = (id) => api.patch(`/notifications/${id}/read`);
export const markUnread = (id) => api.patch(`/notifications/${id}/unread`);
export const markAllRead = (category) => api.patch(`/notifications/read-all${category ? `?category=${encodeURIComponent(category)}` : ''}`);
export const deleteNotification = (id) => api.del(`/notifications/${id}`);
// preferences plus `email: { available, address (masked), hourlyCap }`: whether the SERVER can send e-mail at all
export const getPreferences = () => api.get('/notifications/preferences').then((r) => ({ ...r.data.preferences, email: r.data.email }));
export const sendTestEmail = () => api.post('/notifications/email/test').then((r) => r.data);
export const savePreferences = (patch) => api.put('/notifications/preferences', patch).then((r) => r.data.preferences);

export const CATEGORIES = [
  ['BUDGET', 'Budget', 'bullseye', 'budget'],
  ['GOALS', 'Goals', 'piggy-bank', 'goals'],
  ['SUBSCRIPTIONS', 'Subscriptions', 'rotate', 'subscriptions'],
  ['RECURRING', 'Recurring', 'repeat', 'recurring'],
  ['UNUSUAL_SPENDING', 'Unusual spending', 'magnifying-glass-chart', 'unusualSpending'],
  ['INSIGHTS', 'Insights', 'lightbulb', 'insights'],
  ['SYSTEM', 'System', 'circle-info', 'system'],
];
