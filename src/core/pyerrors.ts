// Plain-English translation of Python tracebacks.
//
// The people using this tool are accountants, not programmers. A raw traceback
// ending in `KeyError: 'Amount '` is where they stop and email someone. Each
// rule below turns one common failure into a sentence that names the thing that
// actually went wrong and says what to do about it — the raw traceback stays
// available behind a toggle for anyone who wants it. Pure and unit-tested.

export interface ExplainContext {
  /** Column names across every registered table, for "did you mean" hints. */
  columns?: string[];
  /** Python names in scope (df_sales, tables, …), for NameError hints. */
  names?: string[];
}

export interface Explained {
  /** One sentence, no jargon: what went wrong. */
  title: string;
  /** What to do about it. Omitted when the title says everything. */
  hint?: string;
  /** 1-based line within the cell, when the traceback pinpoints one. */
  line?: number;
  /** The original traceback, always kept. */
  raw: string;
}

/** Levenshtein distance, capped — only used on short identifier strings. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** True when every letter of `short` appears in `long` in order (amt → amount). */
function isAbbreviation(short: string, long: string): boolean {
  if (short.length < 3 || short.length >= long.length) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

/** Closest candidate to `target`, if one is close enough to be worth naming. */
export function closest(target: string, candidates: string[]): string | undefined {
  const t = target.trim().toLowerCase();
  if (!t || !candidates.length) return undefined;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(t, c.trim().toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // Allow roughly a third of the length to differ — catches case, spaces, typos.
  if (best !== undefined && bestD <= Math.max(2, Math.floor(t.length / 3))) return best;

  // Headings in finance data are abbreviated constantly (Amt, Dept, Qty), and
  // people type the full word. Edit distance is too strict for that, so fall
  // back to an in-order letter match, preferring the shortest candidate.
  const abbreviated = candidates
    .filter((c) => {
      const l = c.trim().toLowerCase();
      return isAbbreviation(l, t) || isAbbreviation(t, l);
    })
    .sort((a, b) => a.length - b.length);
  return abbreviated[0];
}

const didYouMean = (name: string, candidates: string[] | undefined): string => {
  const near = closest(name, candidates ?? []);
  return near ? ` Did you mean "${near}"?` : '';
};

/** Last `EType: message` line of a traceback. */
function finalLine(raw: string): { etype: string; message: string } {
  const lines = raw.trimEnd().split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*([A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit))\s*:\s*([\s\S]*)$/);
    if (m) return { etype: m[1].split('.').pop()!, message: m[2].trim() };
    const bare = lines[i].match(/^\s*([A-Za-z_][\w.]*(?:Error|Exception|Interrupt))\s*$/);
    if (bare) return { etype: bare[1].split('.').pop()!, message: '' };
  }
  return { etype: '', message: lines[lines.length - 1] ?? '' };
}

/** 1-based line number inside the cell, from the `File "<cell>", line N` frame. */
function cellLine(raw: string): number | undefined {
  const matches = [...raw.matchAll(/File "<cell>", line (\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : undefined;
}

const quoted = (s: string): string | undefined => s.match(/'([^']*)'|"([^"]*)"/)?.slice(1).find((x) => x !== undefined);

/**
 * Turn a Python traceback into something a non-programmer can act on.
 * Always returns a result — unmatched errors get a readable generic form.
 */
export function explainPythonError(raw: string, ctx: ExplainContext = {}): Explained {
  const { etype, message } = finalLine(raw);
  const line = cellLine(raw);
  const at = (e: Omit<Explained, 'raw' | 'line'>): Explained => ({ ...e, line, raw });

  // A few pandas failures are worth recognising by their message rather than
  // their class — they arrive as plain ValueErrors and would otherwise fall
  // into the generic branch below.
  if (/columns overlap but no suffix/.test(message)) {
    return at({
      title: 'Both tables have columns with the same name.',
      hint: 'Give them suffixes so you can tell them apart: merge(..., suffixes=("_left", "_right")).',
    });
  }
  if (/You are trying to merge on/.test(message)) {
    return at({
      title: 'The join key is text in one table and a number in the other.',
      hint: 'Make them match first, e.g. df_x["ID"] = df_x["ID"].astype(str).',
    });
  }

  switch (etype) {
    case 'KeyError': {
      const key = quoted(message) ?? message.replace(/^['"]|['"]$/g, '');
      const spacey = key !== key.trim() ? ' Note the extra space in the name — column headings often carry one.' : '';
      return at({
        title: `There is no column called "${key}".`,
        hint: `Check the spelling and capitals against the table list on the right.${didYouMean(key, ctx.columns)}${spacey}`,
      });
    }
    case 'NameError': {
      const name = quoted(message) ?? '';
      return at({
        title: `"${name}" hasn't been created yet.`,
        hint:
          `Either it is a typo, or the cell that creates it hasn't run.${didYouMean(name, ctx.names)}` +
          ' Use Run all to run the cells above this one in order.',
      });
    }
    case 'ModuleNotFoundError':
    case 'ImportError': {
      const mod = quoted(message) ?? '';
      return at({
        title: `The "${mod}" library isn't available here.`,
        hint: 'This notebook runs offline with a fixed set of libraries — pandas and matplotlib are included. Nothing can be downloaded.',
      });
    }
    case 'SyntaxError':
      return at({
        title: 'Python could not read this cell — there is a typo in the code itself.',
        hint: 'Most often a missing colon at the end of an if/for line, an unclosed bracket or quote, or a stray character.',
      });
    case 'IndentationError':
    case 'TabError':
      return at({
        title: 'The indentation is off.',
        hint: 'Lines inside an if/for/def block must be indented by the same amount — use spaces, not tabs, and keep it consistent.',
      });
    case 'TypeError': {
      if (/unsupported operand type|can only concatenate|not supported between instances/.test(message)) {
        return at({
          title: 'A calculation mixed text with numbers.',
          hint: 'A column that looks numeric probably contains text (blanks, "-", "N/A", or numbers stored as text). Convert it first: pd.to_numeric(df_x["Col"], errors="coerce").',
        });
      }
      if (/string indices must be integers/.test(message)) {
        return at({
          title: 'A row was treated like a table.',
          hint: 'You are indexing a single row with a column name. Loop over rows, or work on the whole DataFrame at once.',
        });
      }
      if (/unhashable type/.test(message)) {
        return at({ title: 'A list was used where a single value was expected.', hint: 'Check for an extra pair of brackets around a column name.' });
      }
      if (/object is not callable/.test(message)) {
        return at({ title: 'Something was used as if it were a function.', hint: 'This is usually a missing operator or a name reused for two different things.' });
      }
      if (/missing \d+ required positional argument|takes \d+ positional/.test(message)) {
        return at({ title: 'A function was called with the wrong number of inputs.', hint: message });
      }
      return at({ title: 'The wrong kind of value was used in this step.', hint: message });
    }
    case 'ValueError': {
      if (/could not convert string to float|invalid literal for int/.test(message)) {
        const bad = quoted(message);
        return at({
          title: `A column contains text that isn't a number${bad ? ` — for example ${JSON.stringify(bad)}` : ''}.`,
          hint: 'Clean it first with the Clean tool, or use pd.to_numeric(df_x["Col"], errors="coerce") to turn the bad entries into blanks.',
        });
      }
      if (/Length of values .* does not match length of index|Length mismatch/.test(message)) {
        return at({
          title: 'The new column has a different number of rows than the table.',
          hint: 'The values being assigned must line up one-to-one with the table\'s rows.',
        });
      }
      if (/No numeric types to aggregate|No group keys passed|Cannot aggregate/.test(message)) {
        return at({
          title: 'There is nothing numeric to total in this grouping.',
          hint: 'The value column is being read as text. Convert it with pd.to_numeric(...) before grouping.',
        });
      }
      if (/cannot reindex|duplicate/i.test(message)) {
        return at({ title: 'The key column has duplicate values, so the rows cannot be matched one-to-one.', hint: 'Dedupe the key first, or use merge() instead of join().' });
      }
      return at({ title: 'A value was not what this step expected.', hint: message });
    }
    case 'AttributeError': {
      const attr = message.match(/has no attribute '([^']+)'/)?.[1];
      if (/'DataFrame'|'Series'/.test(message) && attr) {
        return at({
          title: `Tables have no "${attr}" — it is either a misspelled command or a column name.`,
          hint: `To read a column, write df_x["${attr}"] with square brackets and quotes.${didYouMean(attr, ctx.columns)}`,
        });
      }
      if (/'NoneType'/.test(message)) {
        return at({
          title: 'A step produced nothing, and the next step tried to use it.',
          hint: 'Some pandas commands change the table in place and return nothing — check for a stray inplace=True.',
        });
      }
      return at({ title: attr ? `"${attr}" isn't something this value can do.` : 'That command does not exist on this value.', hint: message });
    }
    case 'IndexError':
      return at({ title: 'The row or position asked for is past the end of the data.', hint: 'Counting starts at 0, so the last row of 10 is number 9.' });
    case 'ZeroDivisionError':
      return at({ title: 'Something was divided by zero.', hint: 'Filter the zero rows out first, or guard the division so blank denominators produce a blank result.' });
    case 'FileNotFoundError':
    case 'OSError':
      return at({
        title: 'This notebook cannot read files from your computer.',
        hint: 'That is deliberate — nothing here touches your disk. Add the file with the drop area at the top and it becomes a table you can use.',
      });
    case 'MemoryError':
      return at({
        title: 'The data was too large for the browser to hold.',
        hint: 'Work on fewer columns or filter the rows down first, then run the step again.',
      });
    case 'KeyboardInterrupt':
      return at({ title: 'Stopped.', hint: 'The engine was restarted, so your tables are still registered but variables from earlier cells are gone. Use Run all to rebuild them.' });
    case 'RecursionError':
      return at({ title: 'A calculation called itself too many times.', hint: 'Usually a loop that never ends — check the stopping condition.' });
    case 'UnicodeDecodeError':
      return at({ title: 'Some text could not be read in this encoding.', hint: 'Non-English characters in the source file are the usual cause.' });
    case 'MergeError':
      return at({ title: 'The two tables could not be joined.', hint: message || 'Check that the key column exists in both and holds the same kind of value.' });
    default: {
      return at({
        title: etype ? `Python stopped with a ${etype}.` : 'Python stopped with an error.',
        hint: message || 'Open the technical details below for the exact message.',
      });
    }
  }
}
