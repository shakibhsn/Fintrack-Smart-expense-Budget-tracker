// Accessible dropdown behaviour for a trigger button + menu element:
// toggles on click, closes on outside click / Escape / focus leaving, arrow keys move between [role=menuitem]s,
// aria-expanded kept in sync. Returns { open, close, isOpen, destroy }.
export function bindDropdown({ trigger, menu, onOpen, signal }) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  const isOpen = () => !menu.hidden;
  const close = ({ restoreFocus = false } = {}) => {
    if (!isOpen()) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  };
  const open = () => {
    if (isOpen()) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (onOpen) onOpen();
  };

  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', (e) => { e.stopPropagation(); if (isOpen()) close(); else open(); }, { signal });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(); (items()[0] || menu).focus(); }
  }, { signal });
  document.addEventListener('click', (e) => { if (isOpen() && !menu.contains(e.target) && !trigger.contains(e.target)) close(); }, { signal });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close({ restoreFocus: true }); }, { signal });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0])?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1])?.focus(); }
  }, { signal });
  menu.addEventListener('focusout', (e) => { if (isOpen() && e.relatedTarget && !menu.contains(e.relatedTarget) && !trigger.contains(e.relatedTarget)) close(); }, { signal });

  return { open, close, isOpen };
}
