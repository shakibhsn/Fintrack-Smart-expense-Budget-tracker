import { api } from '../../services/apiClient.js';

// GET /api/health-score: transparent 0-100 score with component breakdown and history; `available: false` when data is insufficient.
export const getHealthScore = () => api.get('/health-score').then((r) => r.data);
