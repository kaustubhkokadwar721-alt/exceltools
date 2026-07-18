// In-app help: a collapsed "How this works" panel per tool, rendered from the
// registry's help steps. Offline, no network — guidance travels with the app.
// Uses the Registry review/details pattern.
import { findTool } from '../app/registry';

/** Append a help <details> into the tool's .tool-head (idempotent per mount). */
export function attachHelp(root: HTMLElement, toolId: string): void {
  const tool = findTool(toolId);
  if (!tool?.help?.length) return;
  const head = root.querySelector('.tool-head');
  if (!head || head.querySelector('.rgy-help')) return;

  const details = document.createElement('details');
  details.className = 'rgy-help';
  const steps = tool.help.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  const note = tool.helpNote ? `<p class="rgy-help__note">${escapeHtml(tool.helpNote)}</p>` : '';
  details.innerHTML =
    `<summary>How this works</summary>` +
    `<div class="rgy-help__body"><ol class="rgy-help__steps">${steps}</ol>${note}</div>`;
  head.appendChild(details);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
