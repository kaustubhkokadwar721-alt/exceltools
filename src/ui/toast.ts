// Tiny transient notification system for validation errors/warnings/success.
// One container, auto-dismissing messages. Shared by all tools.

type Kind = 'error' | 'warning' | 'success' | 'info';

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toasts';
    document.body.appendChild(container);
  }
  return container;
}

export function toast(message: string, kind: Kind = 'info', timeoutMs = 5000): void {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  ensureContainer().appendChild(el);
  const remove = () => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', remove);
  if (timeoutMs > 0) setTimeout(remove, timeoutMs);
}
