import { api } from '../../services/apiClient.js';

// GET /api/forecast?period=next_7_days|next_30_days|next_3_months|next_6_months
// Weighted moving average over the user's own complete months, computed and cached on the server. `available: false` means
// "not enough history", in which case no numbers are returned at all.
export const PERIODS = [['next_7_days', 'Next 7 days'], ['next_30_days', 'Next 30 days'], ['next_3_months', 'Next 3 months'], ['next_6_months', 'Next 6 months']];
export const getForecast = (period) => api.get('/forecast', { period }).then((r) => r.data);
