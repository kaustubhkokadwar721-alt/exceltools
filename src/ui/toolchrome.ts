// Chrome that gets out of the way once you start working.
//
// A tool's heading, blurb, help panel and drop area are all onboarding: they
// matter for the first thirty seconds and then they are just eating the screen.
// On a 1080px laptop they push the actual work below the fold. These helpers
// shrink the header and swap the drop area for a one-line summary of what is
// loaded, with a way back to both.
import { el, button } from './controls';

/**
 * Collapse (or restore) a tool's heading block. Compact keeps the title as an
 * anchor, drops the blurb, and closes the help panel — all reversible, and the
 * help summary stays clickable.
 */
export function setHeadCompact(root: HTMLElement, compact: boolean): void {
  const head = root.querySelector<HTMLElement>('.tool-head');
  if (!head) return;
  head.classList.toggle('is-compact', compact);
  if (compact) head.querySelector('details.rgy-help')?.removeAttribute('open');
}

export interface SourceBarItem {
  name: string;
  meta: string;
}

export interface SourceBarOptions {
  items: SourceBarItem[];
  /** Shown before the list, e.g. "2 tables ready". */
  summary: string;
  addLabel: string;
  onAdd: () => void;
}

/**
 * The collapsed stand-in for a drop area: what is loaded, and a way to add
 * more. Replaces ~250px of empty dropzone with ~40px of useful state.
 */
export function createSourceBar(opts: SourceBarOptions): HTMLElement {
  const chips = opts.items.map((i) =>
    el('span', { class: 'src-chip', title: i.meta }, [
      el('span', { class: 'src-chip-name' }, [i.name]),
      el('span', { class: 'src-chip-meta' }, [i.meta]),
    ]),
  );
  return el('div', { class: 'src-bar' }, [
    el('span', { class: 'src-bar-summary' }, [opts.summary]),
    el('div', { class: 'src-bar-list' }, chips),
    button(opts.addLabel, opts.onAdd, 'btn-ghost src-bar-add'),
  ]);
}
