import { api } from '../../services/apiClient.js';

// GET /api/insights: rule-based insights from the user's own data (no AI/ML). Cached server-side until their data changes.
export const getInsights = () => api.get('/insights').then((r) => r.data);
