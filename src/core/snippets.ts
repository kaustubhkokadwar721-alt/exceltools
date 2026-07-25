// The recipe library behind the notebook's "Insert a step" panel.
//
// A blank cell is a wall if you don't write Python. Each recipe below is a
// finance task in plain English that expands into runnable code with the user's
// own table and column names already filled in — so the first thing they see is
// working code they can read and adjust, not a blinking cursor. Pure and
// unit-tested; the tool layer only picks a recipe and inserts the string.
import type { ColumnKind } from './types';

export interface SnippetColumn {
  name: string;
  kind: ColumnKind;
}

export interface SnippetTable {
  /** Python name — `df_<name>` with pandas, `tables["<name>"]` without. */
  name: string;
  columns: SnippetColumn[];
}

export interface SnippetContext {
  tables: SnippetTable[];
  pandas: boolean;
  charts: boolean;
}

export interface Snippet {
  id: string;
  group: 'Look at the data' | 'Summarise' | 'Filter and sort' | 'Compare tables' | 'Charts';
  label: string;
  blurb: string;
  code: string;
}

const py = (t: SnippetTable): string => `df_${t.name}`;
const q = (s: string): string => JSON.stringify(s);

const firstOf = (t: SnippetTable, kinds: ColumnKind[]): SnippetColumn | undefined =>
  t.columns.find((c) => kinds.includes(c.kind));

/** Reference numbers are numeric but never worth totalling. */
const ID_LIKE = /(^|[_\s])(id|no|nos|num|number|ref|reference|code|key|serial|sr|srno|year|line)([_\s.]|$)/i;

/** A sensible grouping column: prefer text, fall back to the first column. */
const groupCol = (t: SnippetTable): SnippetColumn | undefined => firstOf(t, ['text', 'boolean']) ?? t.columns[0];

/**
 * A sensible column to add up. Totalling an invoice number is never what
 * anyone meant, so identifier-looking columns are passed over first.
 */
const valueCol = (t: SnippetTable): SnippetColumn | undefined => {
  const numeric = t.columns.filter((c) => c.kind === 'number');
  return numeric.find((c) => !ID_LIKE.test(c.name)) ?? numeric[0] ?? t.columns[t.columns.length - 1];
};

/** Column that looks like it holds dates, by name. */
const dateCol = (t: SnippetTable): SnippetColumn | undefined =>
  t.columns.find((c) => /date|month|period|day|posted|invoice.?dt/i.test(c.name));

/**
 * Build the recipe list for the tables currently registered. Recipes whose
 * inputs don't exist (no second table, no numeric column, no charts) are left
 * out rather than offered and broken.
 */
export function snippetsFor(ctx: SnippetContext): Snippet[] {
  const out: Snippet[] = [];
  const [t, t2] = ctx.tables;
  if (!t || !t.columns.length) return out;

  const g = groupCol(t);
  const v = valueCol(t);
  const d = dateCol(t);

  if (!ctx.pandas) {
    // Pandas missing (offline build without the wheel) — plain Python only.
    out.push({
      id: 'peek-plain',
      group: 'Look at the data',
      label: 'See the first few rows',
      blurb: 'Prints the first 10 rows so you can check the data loaded correctly.',
      code: `rows = tables[${q(t.name)}]\nprint(len(rows), "rows")\nrows[:10]`,
    });
    if (g && v) {
      out.push({
        id: 'total-plain',
        group: 'Summarise',
        label: `Total ${v.name} by ${g.name}`,
        blurb: 'Adds up one column, grouped by another.',
        code:
          `totals = {}\n` +
          `for r in tables[${q(t.name)}]:\n` +
          `    key = r[${q(g.name)}]\n` +
          `    totals[key] = totals.get(key, 0) + (r[${q(v.name)}] or 0)\n\n` +
          `[{${q(g.name)}: k, "Total": v} for k, v in sorted(totals.items())]`,
      });
    }
    return out;
  }

  out.push({
    id: 'peek',
    group: 'Look at the data',
    label: 'See the first few rows',
    blurb: 'Shows the top 20 rows — the quickest way to check the file loaded correctly.',
    code: `${py(t)}.head(20)`,
  });

  out.push({
    id: 'shape',
    group: 'Look at the data',
    label: 'How many rows and columns?',
    blurb: 'Row count, column names and how many blanks each column has.',
    code:
      `print(${py(t)}.shape[0], "rows ×", ${py(t)}.shape[1], "columns")\n` +
      `${py(t)}.isna().sum().rename("blanks").to_frame()`,
  });

  out.push({
    id: 'describe',
    group: 'Look at the data',
    label: 'Summary statistics',
    blurb: 'Count, average, smallest and largest for every numeric column.',
    code: `${py(t)}.describe().reset_index()`,
  });

  if (g) {
    out.push({
      id: 'count-by',
      group: 'Summarise',
      label: `Count rows by ${g.name}`,
      blurb: 'How many rows fall under each value — the fastest sanity check on a category column.',
      code: `${py(t)}[${q(g.name)}].value_counts().rename_axis(${q(g.name)}).reset_index(name="Rows")`,
    });
  }

  if (g && v && v.kind === 'number') {
    out.push({
      id: 'total-by',
      group: 'Summarise',
      label: `Total ${v.name} by ${g.name}`,
      blurb: 'The group-and-add-up step behind most reconciliations.',
      code:
        `(${py(t)}\n` +
        `    .groupby(${q(g.name)}, as_index=False)[${q(v.name)}]\n` +
        `    .sum()\n` +
        `    .sort_values(${q(v.name)}, ascending=False))`,
    });

    out.push({
      id: 'pct-of-total',
      group: 'Summarise',
      label: `${v.name} as a % of the total`,
      blurb: 'Adds a percentage-of-total column next to each group.',
      code:
        `summary = ${py(t)}.groupby(${q(g.name)}, as_index=False)[${q(v.name)}].sum()\n` +
        `summary["% of total"] = (summary[${q(v.name)}] / summary[${q(v.name)}].sum() * 100).round(1)\n` +
        `summary.sort_values("% of total", ascending=False)`,
    });

    out.push({
      id: 'top-10',
      group: 'Filter and sort',
      label: `Top 10 rows by ${v.name}`,
      blurb: 'The largest values, biggest first.',
      code: `${py(t)}.nlargest(10, ${q(v.name)})`,
    });
  }

  if (t.columns.length >= 2 && g && v && v.kind === 'number') {
    const second = t.columns.find((c) => c.name !== g.name && c.name !== v.name);
    if (second) {
      out.push({
        id: 'pivot',
        group: 'Summarise',
        label: `Pivot: ${g.name} down, ${second.name} across`,
        blurb: 'A cross-tab of totals — the spreadsheet pivot table, in one step.',
        code:
          `(${py(t)}\n` +
          `    .pivot_table(index=${q(g.name)}, columns=${q(second.name)}, values=${q(v.name)},\n` +
          `                 aggfunc="sum", fill_value=0)\n` +
          `    .reset_index())`,
      });
    }
  }

  if (v && v.kind === 'number') {
    out.push({
      id: 'filter',
      group: 'Filter and sort',
      label: `Rows where ${v.name} is above a number`,
      blurb: 'Change the number to whatever threshold you need.',
      code: `threshold = 0\n${py(t)}[${py(t)}[${q(v.name)}] > threshold]`,
    });
  }

  out.push({
    id: 'blanks',
    group: 'Filter and sort',
    label: 'Rows with something missing',
    blurb: 'Every row that has a blank in any column — usually the first thing to fix.',
    code: `${py(t)}[${py(t)}.isna().any(axis=1)]`,
  });

  if (g) {
    out.push({
      id: 'dupes',
      group: 'Filter and sort',
      label: `Duplicate ${g.name} values`,
      blurb: 'Shows every row whose key appears more than once.',
      code: `${py(t)}[${py(t)}.duplicated(${q(g.name)}, keep=False)].sort_values(${q(g.name)})`,
    });
  }

  if (t2 && t2.columns.length) {
    const shared = t.columns.find((c) => t2.columns.some((c2) => c2.name === c.name));
    const key = shared?.name ?? t.columns[0].name;
    out.push({
      id: 'missing-from',
      group: 'Compare tables',
      label: `Rows in ${t.name} that are missing from ${t2.name}`,
      blurb: `Matches the two tables on "${key}" and keeps what only exists in the first.`,
      code:
        `merged = ${py(t)}.merge(${py(t2)}, on=${q(key)}, how="left", indicator=True,\n` +
        `                        suffixes=("", "_${t2.name}"))\n` +
        `merged[merged["_merge"] == "left_only"].drop(columns="_merge")`,
    });
    out.push({
      id: 'matched',
      group: 'Compare tables',
      label: `Match ${t.name} against ${t2.name}`,
      blurb: `Joins both tables on "${key}" so you can compare their columns side by side.`,
      code: `${py(t)}.merge(${py(t2)}, on=${q(key)}, how="inner", suffixes=("_${t.name}", "_${t2.name}"))`,
    });
  }

  if (ctx.charts && g && v && v.kind === 'number') {
    out.push({
      id: 'bar',
      group: 'Charts',
      label: `Bar chart of ${v.name} by ${g.name}`,
      blurb: 'Draws the chart underneath the cell. Right-click it to save the picture.',
      code:
        `import matplotlib.pyplot as plt\n\n` +
        `summary = ${py(t)}.groupby(${q(g.name)})[${q(v.name)}].sum().sort_values(ascending=False)\n` +
        `ax = summary.plot(kind="bar", color="#1f5c3d")\n` +
        `ax.set_ylabel(${q(v.name)})\n` +
        `ax.set_title(${q(`${v.name} by ${g.name}`)})\n` +
        `plt.tight_layout()`,
    });

    if (d) {
      out.push({
        id: 'trend',
        group: 'Charts',
        label: `${v.name} over time (${d.name})`,
        blurb: 'Totals by month and draws the trend line.',
        code:
          `import matplotlib.pyplot as plt\n\n` +
          `t = ${py(t)}.copy()\n` +
          `t[${q(d.name)}] = pd.to_datetime(t[${q(d.name)}], errors="coerce")\n` +
          `monthly = t.dropna(subset=[${q(d.name)}]).groupby(t[${q(d.name)}].dt.to_period("M"))[${q(v.name)}].sum()\n` +
          `monthly.index = monthly.index.astype(str)\n` +
          `ax = monthly.plot(marker="o", color="#1f5c3d")\n` +
          `ax.set_ylabel(${q(v.name)})\n` +
          `plt.tight_layout()`,
      });
    }
  }

  return out;
}
