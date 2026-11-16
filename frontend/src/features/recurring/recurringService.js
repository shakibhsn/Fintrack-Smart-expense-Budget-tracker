import { api } from '../../services/apiClient.js';

// Recurring transactions API. Schedules live in the database and are processed by the SERVER (a scheduler plus on-demand
// processing when the user opens the app), never by the browser. Listing them also processes anything that is due.
export const listRecurring = () => api.get('/recurring').then((r) => r.data.recurring);
export const createRecurring = (payload) => api.post('/recurring', payload).then((r) => r.data.recurring);
export const updateRecurring = (id, payload) => api.put(`/recurring/${id}`, payload).then((r) => r.data.recurring);
export const deleteRecurring = (id) => api.del(`/recurring/${id}`); // generated transactions are kept
export const pauseRecurring = (id) => api.post(`/recurring/${id}/pause`).then((r) => r.data.recurring);
export const resumeRecurring = (id, catchUp) => api.post(`/recurring/${id}/resume`, { catchUp }).then((r) => r.data.recurring);
export const getOccurrences = (id) => api.get(`/recurring/${id}/occurrences`).then((r) => r.data); // { schedule, upcoming, history }
