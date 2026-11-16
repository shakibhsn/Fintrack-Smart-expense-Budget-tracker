import { api } from '../../services/apiClient.js';

// GET /api/analytics/overview?period=this_month|last_month|last_3_months|last_6_months|this_year|custom[&startDate=&endDate=]
// Everything (totals, series, category breakdowns, previous-period comparison) is aggregated by the database for the signed-in user.
export const getAnalyticsOverview = ({ period, startDate, endDate }) =>
  api.get('/analytics/overview', { period, startDate, endDate }).then((r) => r.data);
