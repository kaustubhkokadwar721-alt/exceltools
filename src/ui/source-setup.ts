// Setup card for one detected Excel Table: rename the table, include/rename/type
// each column, or skip type detection (import as text). Emits a live SourceSpec.
import { el } from './controls';
import { buildDefaultSpec } from '../core/source';
import type { TableDef, SourceSpec, ColType } from '../core/types';

const TYPES: { value: ColType; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Boolean' },
];

export interface SourceSetup {
  el: HTMLElement;
  def: TableDef;
  getSpec: () => SourceSpec;
}

/** Build an editable setup card for a table. Reads live values via getSpec(). */
export function tableSetupCard(def: TableDef): SourceSetup {
  const spec = buildDefaultSpec(def);

  const nameInput = el('input', { class: 'field-input', value: spec.name }) as HTMLInputElement;

  const skip = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const skipLabel = el('label', { class: 'checkbox' }, [skip, el('span', {}, ['Skip type detection — import as text'])]);

  const colRows = spec.columns.map((c) => {
    const include = el('input', { type: 'checkbox' }) as HTMLInputElement;
    include.checked = c.include;
    const rename = el('input', { class: 'field-input col-name', value: c.name }) as HTMLInputElement;
    const typeSel = el('select', { class: 'field-select col-type' }) as HTMLSelectElement;
    for (const t of TYPES) {
      const o = el('option', { value: t.value }, [t.label]);
      if (t.value === c.type) (o as HTMLOptionElement).selected = true;
      typeSel.append(o);
    }
    const row = el('div', { class: 'col-row' }, [
      el('label', { class: 'checkbox' }, [include, el('span', { class: 'col-src' }, [c.source])]),
      rename,
      typeSel,
    ]);
    return { source: c.source, include, rename, typeSel, row };
  });

  const applySkip = () => {
    colRows.forEach((r) => (r.typeSel.disabled = skip.checked));
  };
  skip.addEventListener('change', applySkip);

  const card = el('div', { class: 'source-card' }, [
    el('div', { class: 'source-card-head' }, [
      el('span', { class: 'field-label' }, ['Table name']),
      nameInput,
      skipLabel,
    ]),
    el('div', { class: 'col-editor' }, [
      el('div', { class: 'col-row col-row-head' }, [
        el('span', {}, ['Include']),
        el('span', {}, ['Column name']),
        el('span', {}, ['Type']),
      ]),
      ...colRows.map((r) => r.row),
    ]),
  ]);

  const getSpec = (): SourceSpec => ({
    name: nameInput.value.trim() || def.name,
    skipTypeDetection: skip.checked,
    columns: colRows.map((r) => ({
      source: r.source,
      name: r.rename.value.trim() || r.source,
      include: r.include.checked,
      type: r.typeSel.value as ColType,
    })),
  });

  return { el: card, def, getSpec };
}
