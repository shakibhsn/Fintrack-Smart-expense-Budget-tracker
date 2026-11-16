import { api } from '../../services/apiClient.js';

// Unusual-spending detections are computed (and persisted so they can be reviewed/dismissed) by the backend.
// Changing a detection's status never touches the underlying transactions.
export const getUnusualSpending = (status = 'active') => api.get('/unusual-spending', { status }).then((r) => r.data);
export const setDetectionStatus = (id, status) => api.patch(`/unusual-spending/${id}`, { status }).then((r) => r.data);
export const getRelatedTransactions = (id) => api.get(`/unusual-spending/${id}/transactions`).then((r) => r.data.transactions);
// Number of findings still waiting for review (sidebar badge).
export const getUnusualCounts = () => getUnusualSpending('active').then((d) => d.counts.new);
