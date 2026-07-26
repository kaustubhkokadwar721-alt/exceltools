// The drop area is onboarding: it matters for the first thirty seconds and then
// it is just eating the screen. Once files are loaded it becomes a one-line
// summary of what is there, with a way back.
//
// The heading and help block used to be collapsed here too; they now live in
// the app bar and its help popover, so there is nothing left to shrink.
import { el, button } from './controls';

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
