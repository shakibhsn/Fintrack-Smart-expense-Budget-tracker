// Shared by the Insights page and the Dashboard preview. Meaning is carried by an icon AND a word, never colour alone.
export const INSIGHT_STYLE = {
  alert: { icon: 'circle-exclamation', tone: 'danger', label: 'Alert' },
  warning: { icon: 'triangle-exclamation', tone: 'warning', label: 'Warning' },
  positive: { icon: 'circle-check', tone: 'success', label: 'Good news' },
  info: { icon: 'circle-info', tone: 'accent', label: 'Info' },
  suggestion: { icon: 'lightbulb', tone: 'brand', label: 'Suggestion' },
};
export const INSIGHT_ORDER = { alert: 0, warning: 1, positive: 2, info: 3, suggestion: 4 };
export const INSIGHT_GROUPS = [
  ['spending', 'Spending', 'cart-shopping'],
  ['budget', 'Budget', 'bullseye'],
  ['savings', 'Savings', 'piggy-bank'],
  ['habits', 'Financial habits', 'repeat'],
  ['recommendations', 'Recommendations', 'lightbulb'],
];
