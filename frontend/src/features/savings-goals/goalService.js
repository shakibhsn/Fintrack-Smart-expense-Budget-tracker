import { api } from '../../services/apiClient.js';

// Savings goals API. Progress, remaining, status and "excess" are computed by the server (one shared formula);
// the frontend only displays them. Contributions are the only way saved money changes.
export const listGoals = () => api.get('/goals').then((r) => r.data.goals);
export const getGoalsSummary = () => api.get('/goals/summary').then((r) => r.data);
export const createGoal = (payload) => api.post('/goals', payload).then((r) => r.data.goal);
export const updateGoal = (id, payload) => api.put(`/goals/${id}`, payload).then((r) => r.data.goal);
export const deleteGoal = (id) => api.del(`/goals/${id}`);
export const addContribution = (id, payload) => api.post(`/goals/${id}/contributions`, payload).then((r) => r.data); // { goal, contribution }
export const getContributions = (id) => api.get(`/goals/${id}/contributions`).then((r) => r.data); // { goal, contributions }
