// Route table: the single list of pages. The router loads them lazily (a page's code is only downloaded the first time it is
// visited) and the sidebar is built from the same list, so adding a page = adding one line here.
//
// Hash routes (#/transactions) work on any static host, survive a browser refresh and need no server rewrite rules.

export const ROUTES = [
  { path: '/dashboard', title: 'Dashboard', icon: 'chart-pie', section: 'Overview', load: () => import('../features/dashboard/dashboardPage.js') },
  { path: '/transactions', title: 'Transactions', icon: 'receipt', section: 'Overview', load: () => import('../features/transactions/transactionsPage.js') },
  { path: '/budgets', title: 'Budgets', icon: 'bullseye', section: 'Overview', load: () => import('../features/budgets/budgetsPage.js') },
  { path: '/analytics', title: 'Analytics', icon: 'chart-line', section: 'Overview', load: () => import('../features/analytics/analyticsPage.js') },
  { path: '/savings-goals', title: 'Savings Goals', icon: 'piggy-bank', section: 'Overview', load: () => import('../features/savings-goals/savingsGoalsPage.js') },
  { path: '/insights', title: 'Smart Insights', icon: 'lightbulb', section: 'Overview', load: () => import('../features/insights/insightsPage.js') },
  { path: '/forecast', title: 'Forecast', icon: 'chart-area', section: 'Financial tools', load: () => import('../features/forecast/forecastPage.js') },
  { path: '/health-score', title: 'Health Score', icon: 'heart-pulse', section: 'Financial tools', load: () => import('../features/health-score/healthScorePage.js') },
  { path: '/anomaly-detection', title: 'Unusual Spending', icon: 'magnifying-glass-chart', section: 'Financial tools', badge: 'anomaly', load: () => import('../features/anomaly-detection/anomalyPage.js') },
  { path: '/simulator', title: 'What-If Simulator', icon: 'sliders', section: 'Financial tools', load: () => import('../features/simulator/simulatorPage.js') },
  { path: '/recurring', title: 'Recurring Transactions', icon: 'repeat', section: 'Financial tools', load: () => import('../features/recurring/recurringPage.js') },
  { path: '/subscriptions', title: 'Subscriptions', icon: 'rotate', section: 'Financial tools', load: () => import('../features/subscriptions/subscriptionsPage.js') },
  { path: '/ai-assistant', title: 'AI Assistant', icon: 'wand-magic-sparkles', section: 'Financial tools', load: () => import('../features/ai-assistant/aiAssistantPage.js') },
  { path: '/reports', title: 'Reports', icon: 'file-lines', section: 'Financial tools', load: () => import('../features/reports/reportsPage.js') },
  { path: '/import', title: 'Import Data', icon: 'file-import', section: 'Data', load: () => import('../features/import-export/importPage.js') },
  { path: '/export', title: 'Export & Backup', icon: 'file-export', section: 'Data', load: () => import('../features/import-export/exportPage.js') },
  { path: '/notifications', title: 'Notifications', icon: 'bell', section: 'Account', badge: 'notifications', load: () => import('../features/notifications/notificationsPage.js') },
  { path: '/settings', title: 'Settings', icon: 'gear', section: 'Account', load: () => import('../features/settings/settingsPage.js') },
];

export const DEFAULT_ROUTE = '/dashboard';
export const findRoute = (path) => ROUTES.find((r) => r.path === path);
