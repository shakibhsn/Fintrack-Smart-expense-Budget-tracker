import { api } from '../../services/apiClient.js';

export const getStatus = () => api.get('/ai/status').then((r) => r.data);
export const saveSettings = (patch) => api.put('/ai/settings', patch).then((r) => r.data.settings);
// range: undefined = let the question decide; otherwise one of the closed range objects the server validates
export const ask = (question, range) => api.post('/ai/ask', { question, ...(range ? { range } : {}) }, { timeout: 30000 }).then((r) => r.data);
export const getRecommendations = () => api.get('/ai/recommendations').then((r) => r.data);
export const dismissRecommendation = (key) => api.post('/ai/recommendations/dismiss', { key });

export const RANGES = [
  ['', 'Use the period in my question'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30', 'Last 30 days'], ['this_year', 'This year'],
];
export const rangeObject = (v) => (!v ? undefined : v === 'last_30' ? { kind: 'last_days', days: 30 } : { kind: v });
