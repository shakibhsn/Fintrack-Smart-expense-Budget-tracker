// Tiny app-wide event bus. Features never call each other; they announce what happened and whoever
// cares (the shell, a badge, a notification list) reacts. Events used:
//   data:changed   { scope: 'transactions' | 'budgets' | 'goals' | 'recurring' | ... }
//   theme:changed  { theme }
const bus = new EventTarget();

export const emit = (name, detail = {}) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export function on(name, handler, { signal } = {}) {
  const listener = (e) => handler(e.detail, e);
  bus.addEventListener(name, listener, { signal });
  return () => bus.removeEventListener(name, listener);
}
