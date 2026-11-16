// Display metadata for goal statuses (status itself is computed by the server).
export const GOAL_STATUS = {
  not_started: { label: 'Not started', tone: 'neutral', bar: '' },
  in_progress: { label: 'In progress', tone: 'accent', bar: '' },
  completed: { label: 'Completed', tone: 'success', bar: '' },
  overdue: { label: 'Overdue', tone: 'danger', bar: 'danger' },
};

export function dueText(g) {
  if (!g.targetDate) return 'No target date';
  if (g.status === 'completed') return `Target date: ${g.targetDate}`;
  const d = g.daysRemaining;
  const rel = d === 0 ? 'due today' : d > 0 ? `${d} day${d === 1 ? '' : 's'} left` : `${-d} day${d === -1 ? '' : 's'} overdue`;
  return `Target date: ${g.targetDate} (${rel})`;
}
