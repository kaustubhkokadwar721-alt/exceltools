// The code cell editor: a plain <textarea> with a syntax-highlighted layer
// painted behind it.
//
// Why not a real editor component: the whole suite ships zero UI dependencies
// and is auditable line by line, and a textarea keeps native undo, spellcheck
// control, IME input, screen-reader behaviour and mobile keyboards for free.
// What it lacks — colour, sane indenting, bracket closing — is added here in
// ~200 lines instead of a few hundred third-party modules.
import { el } from './controls';
import { highlightPython } from '../core/pyhighlight';

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', "'": "'", '"': '"' };

export interface CodeEditorOptions {
  value: string;
  /** 'python' paints syntax colours; 'text' is used for markdown cells. */
  mode?: 'python' | 'text';
  placeholder?: string;
  onChange: (value: string) => void;
  /** Shift+Enter — run and move to the next cell. */
  onRunAdvance?: () => void;
  /** Ctrl/Cmd+Enter — run and stay here. */
  onRun?: () => void;
  /** Alt+Enter — run and insert a new cell below. */
  onRunInsert?: () => void;
  /** Backspace in an empty cell, or Ctrl/Cmd+Shift+Backspace anywhere. */
  onDelete?: () => void;
  /** Arrow-key escape from the top/bottom edge — moves between cells. */
  onLeave?: (dir: -1 | 1) => void;
}

export interface CodeEditor {
  el: HTMLElement;
  textarea: HTMLTextAreaElement;
  getValue(): string;
  setValue(v: string): void;
  focus(atEnd?: boolean): void;
}

export function createCodeEditor(opts: CodeEditorOptions): CodeEditor {
  const mode = opts.mode ?? 'python';
  const highlight = el('pre', { class: 'ce-hl', 'aria-hidden': 'true' });
  const textarea = el('textarea', {
    class: 'ce-input',
    spellcheck: mode === 'python' ? 'false' : 'true',
    rows: '1',
    'aria-label': mode === 'python' ? 'Python code' : 'Note text',
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
  }) as HTMLTextAreaElement;
  textarea.value = opts.value;

  const wrap = el('div', { class: `ce ce-${mode}` }, [highlight, textarea]);

  const paint = (): void => {
    if (mode === 'python') highlight.innerHTML = highlightPython(textarea.value);
    else highlight.textContent = textarea.value + '\n';
  };
  const grow = (): void => {
    textarea.style.height = 'auto';
    const h = Math.max(30, textarea.scrollHeight);
    textarea.style.height = h + 'px';
    highlight.style.height = h + 'px';
  };
  const sync = (): void => {
    paint();
    grow();
  };

  /** Replace the selection, keeping undo history and firing onChange once. */
  const insert = (text: string, selStart?: number, selEnd?: number): void => {
    const start = textarea.selectionStart;
    document.execCommand('insertText', false, text);
    if (selStart !== undefined) textarea.setSelectionRange(start + selStart, start + (selEnd ?? selStart));
    opts.onChange(textarea.value);
    sync();
  };

  const lineStart = (pos: number): number => textarea.value.lastIndexOf('\n', pos - 1) + 1;

  textarea.addEventListener('input', () => {
    opts.onChange(textarea.value);
    sync();
  });
  textarea.addEventListener('scroll', () => {
    highlight.scrollTop = textarea.scrollTop;
  });

  textarea.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const { selectionStart: s, selectionEnd: end, value } = textarea;

    if (e.key === 'Enter' && e.shiftKey && !e.altKey) {
      e.preventDefault();
      opts.onRunAdvance?.();
      return;
    }
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      opts.onRun?.();
      return;
    }
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      opts.onRunInsert?.();
      return;
    }
    if (e.key === 'Backspace' && mod && e.shiftKey) {
      e.preventDefault();
      opts.onDelete?.();
      return;
    }
    if (e.key === 'Backspace' && !value.trim() && opts.onDelete) {
      e.preventDefault();
      opts.onDelete();
      return;
    }

    if (mode !== 'python') return;

    // Tab / Shift+Tab — indent or outdent whole lines when text is selected.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s === end && !e.shiftKey) {
        insert('    ');
        return;
      }
      const from = lineStart(s);
      const to = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end);
      const block = value.slice(from, to);
      const shifted = e.shiftKey
        ? block.split('\n').map((l) => l.replace(/^ {1,4}/, '')).join('\n')
        : block.split('\n').map((l) => '    ' + l).join('\n');
      textarea.setSelectionRange(from, to);
      document.execCommand('insertText', false, shifted);
      textarea.setSelectionRange(from, from + shifted.length);
      opts.onChange(textarea.value);
      sync();
      return;
    }

    // Enter — keep the current indent, and add one level after a colon.
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && s === end) {
      const line = value.slice(lineStart(s), s);
      const indent = line.match(/^\s*/)?.[0] ?? '';
      const deeper = /:\s*$/.test(line) ? '    ' : '';
      if (indent || deeper) {
        e.preventDefault();
        insert('\n' + indent + deeper);
      }
      return;
    }

    // Ctrl/Cmd+/ — comment or uncomment the selected lines.
    if (mod && e.key === '/') {
      e.preventDefault();
      const from = lineStart(s);
      const to = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end);
      const lines = value.slice(from, to).split('\n');
      const allCommented = lines.every((l) => !l.trim() || /^\s*#\s?/.test(l));
      const next = lines
        .map((l) => (allCommented ? l.replace(/^(\s*)#\s?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1# ') : l))
        .join('\n');
      textarea.setSelectionRange(from, to);
      document.execCommand('insertText', false, next);
      textarea.setSelectionRange(from, from + next.length);
      opts.onChange(textarea.value);
      sync();
      return;
    }

    // Auto-close brackets and quotes; wrap the selection when there is one.
    if (PAIRS[e.key]) {
      const close = PAIRS[e.key];
      if (s !== end) {
        e.preventDefault();
        const selected = value.slice(s, end);
        insert(e.key + selected + close, 1, 1 + selected.length);
        return;
      }
      const nextChar = value[s] ?? '';
      const isQuote = e.key === "'" || e.key === '"';
      // Don't auto-pair a quote in the middle of a word (don't → don't).
      if (!isQuote || !/[\w'"]/.test(nextChar + (value[s - 1] ?? ''))) {
        e.preventDefault();
        insert(e.key + close, 1);
        return;
      }
    }
    // Typing the closing character right before it just steps over it.
    if ((e.key === ')' || e.key === ']' || e.key === '}') && value[s] === e.key && s === end) {
      e.preventDefault();
      textarea.setSelectionRange(s + 1, s + 1);
      return;
    }

    // Arrow off the top or bottom edge moves to the neighbouring cell.
    if (opts.onLeave && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && s === end) {
      const atTop = e.key === 'ArrowUp' && !value.slice(0, s).includes('\n');
      const atEnd = e.key === 'ArrowDown' && !value.slice(s).includes('\n');
      if (atTop || atEnd) {
        e.preventDefault();
        opts.onLeave(atTop ? -1 : 1);
      }
    }
  });

  sync();
  // Height depends on layout, which isn't settled on the first paint.
  requestAnimationFrame(grow);

  return {
    el: wrap,
    textarea,
    getValue: () => textarea.value,
    setValue(v: string) {
      textarea.value = v;
      sync();
    },
    focus(atEnd = true) {
      textarea.focus();
      if (atEnd) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    },
  };
}
