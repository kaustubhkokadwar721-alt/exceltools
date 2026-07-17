// Small DOM helpers shared across Phase 2 tool UIs. Keeps each tool file focused
// on its logic rather than element plumbing.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', { class: cls }, [label]);
  b.addEventListener('click', onClick);
  return b;
}

/** Labelled <select> built from options; returns { wrap, select }. */
export function selectField(
  label: string,
  options: { value: string; label: string }[],
  selected?: string,
): { wrap: HTMLElement; select: HTMLSelectElement } {
  const select = el('select', { class: 'field-select' });
  for (const o of options) {
    const opt = el('option', { value: o.value }, [o.label]);
    if (o.value === selected) opt.selected = true;
    select.append(opt);
  }
  const wrap = el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [label]), select]);
  return { wrap, select };
}

export function radioGroup(
  name: string,
  options: { value: string; label: string; hint?: string }[],
  selected: string,
  onChange: (value: string) => void,
): HTMLElement {
  const wrap = el('div', { class: 'radio-group' });
  for (const o of options) {
    const input = el('input', { type: 'radio', name, value: o.value });
    if (o.value === selected) input.checked = true;
    input.addEventListener('change', () => onChange(o.value));
    const row = el('label', { class: 'radio' }, [
      input,
      el('span', { class: 'radio-label' }, [o.label]),
      ...(o.hint ? [el('span', { class: 'radio-hint' }, [o.hint])] : []),
    ]);
    wrap.append(row);
  }
  return wrap;
}
