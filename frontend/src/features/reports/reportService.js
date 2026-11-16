import { api, download } from '../../services/apiClient.js';

const q = (s) => ({ period: s.period, startDate: s.period === 'custom' ? s.startDate : undefined, endDate: s.period === 'custom' ? s.endDate : undefined });

export const getReport = (s) => api.get('/reports', q(s)).then((r) => r.data);
export const exportReport = (s, kind) => download(`/reports/export/${kind}`, q(s), { fallbackName: `fintrack-report.${kind}` });
export const listSnapshots = () => api.get('/reports/snapshots').then((r) => r.data.snapshots);
export const saveSnapshot = (s, title) => api.post('/reports/snapshots', { period: s.period, ...(s.period === 'custom' ? { startDate: s.startDate, endDate: s.endDate } : {}), ...(title ? { title } : {}) }).then((r) => ({ ...r.data, message: r.message }));
export const getSnapshot = (id) => api.get(`/reports/snapshots/${id}`).then((r) => r.data);
export const exportSnapshot = (id, kind) => download(`/reports/snapshots/${id}/${kind}`, undefined, { fallbackName: `fintrack-report.${kind}` });
export const deleteSnapshot = (id) => api.del(`/reports/snapshots/${id}`);
