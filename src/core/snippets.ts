// The recipe library behind the notebook's "Insert a step" panel.
//
// A blank cell is a wall if you don't write Python. Each recipe below is a
// finance task in plain English that expands into runnable code with the user's
// own table and column names.
//
// Recipes are *parameterised*, not fixed: every one declares which columns it
// needs, so the panel can render "Total {PrimaryAmount} by {Status}" with the
// column names as dropdowns. Picking a different column is the single most
// common thing a user wants next, and without this it means editing Python —
// which is exactly the wall the recipes exist to remove. Defaults still come
// from the heuristics below, so one click without touching a dropdown gives a
// sensible step. Pure and unit-tested; the tool layer only renders and inserts.
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

export interface SnippetParam {
  id: string;
  /** Spoken label, for the select's accessible name. */
  label: string;
  kind: 'table' | 'column';
  /** Column params: restrict the choices to these kinds. */
  kinds?: ColumnKind[];
  /** Column params: id of the param naming the table it belongs to. */
  from?: string;
  /** The pre-picked value — what you get if you never open the dropdown. */
  default: string;
}

export interface Snippet {
  id: string;
  group: 'Look at the data' | 'Summarise' | 'Filter and sort' | 'Compare tables' | 'Charts';
  /** `Total {value} by {group}` — braces name params, rendered as dropdowns. */
  template: string;
  blurb: string;
  params: SnippetParam[];
  build(values: Record<string, string>, ctx: SnippetContext): string;
}

const q = (s: string): string => JSON.stringify(s);

/** Reference numbers are numeric but never worth totalling. */
const ID_LIKE = /(^|[_\s])(id|no|nos|num|number|ref|reference|code|key|serial|sr|srno|line)([_\s.]|$)/i;
/** Dates arrive from Excel as numbers; totalling one is always a mistake. */
const DATE_LIKE = /date|month|period|day|posted|quarter|year|dt$/i;

const firstOf = (t: SnippetTable, kinds: ColumnKind[]): SnippetColumn | undefined =>
  t.columns.find((c) => kinds.includes(c.kind));

/** A sensible grouping column: prefer text, fall back to the first column. */
const groupCol = (t: SnippetTable): SnippetColumn | undefined => firstOf(t, ['text', 'boolean']) ?? t.columns[0];

/** A sensible column to add up — never an identifier, never a date. */
const valueCol = (t: SnippetTable): SnippetColumn | undefined => {
  const numeric = t.columns.filter((c) => c.kind === 'number');
  return (
    numeric.find((c) => !ID_LIKE.test(c.name) && !DATE_LIKE.test(c.name)) ??
    numeric.find((c) => !DATE_LIKE.test(c.name)) ??
    numeric[0] ??
    t.columns[t.columns.length - 1]
  );
};

const dateCol = (t: SnippetTable): SnippetColumn | undefined => t.columns.find((c) => DATE_LIKE.test(c.name));

/** The columns a dropdown should offer for one param, given the chosen table. */
export function columnChoices(ctx: SnippetContext, tableName: string, kinds?: ColumnKind[]): SnippetColumn[] {
  const table = ctx.tables.find((t) => t.name === tableName) ?? ctx.tables[0];
  if (!table) return [];
  const matching = kinds ? table.columns.filter((c) => kinds.includes(c.kind)) : table.columns;
  // Never offer an empty dropdown — a loose match beats no choice at all.
  return matching.length ? matching : table.columns;
}

/** The values a recipe starts with: every param's default. */
export function defaultValues(s: Snippet): Record<string, string> {
  return Object.fromEntries(s.params.map((p) => [p.id, p.default]));
}

/** Fill `{param}` placeholders — the spoken form of a recipe's title. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, id: string) => values[id] ?? `{${id}}`);
}

/** Reference to a table in generated code, in whichever dialect is available. */
const ref = (ctx: SnippetContext, name: string): string => (ctx.pandas ? `df_${name}` : `tables[${q(name)}]`);

/**
 * Build the recipe list for the tables currently registered. Recipes whose
 * inputs don't exist (no second table, no numeric column, no charts) are left
 * out rather than offered and broken.
 */
export function snippetsFor(ctx: SnippetContext): Snippet[] {
  const out: Snippet[] = [];
  const [t, t2] = ctx.tables;
  if (!t || !t.columns.length) return out;

  const tableParam = (id = 'table', label = 'Table', def = t.name): SnippetParam => ({ id, label, kind: 'table', default: def });
  const col = (id: string, label: string, def: string | undefined, kinds?: ColumnKind[], from = 'table'): SnippetParam => ({
    id,
    label,
    kind: 'column',
    kinds,
    from,
    default: def ?? '',
  });

  const g = groupCol(t);
  const v = valueCol(t);
  const d = dateCol(t);
  const hasNumber = t.columns.some((c) => c.kind === 'number');

  if (!ctx.pandas) {
    // Pandas missing (offline build without the wheel) — plain Python only.
    out.push({
      id: 'peek-plain',
      group: 'Look at the data',
      template: 'See the first few rows of {table}',
      blurb: 'Prints the first 10 rows so you can check the data loaded correctly.',
      params: [tableParam()],
      build: (val) => `rows = tables[${q(val.table)}]\nprint(len(rows), "rows")\nrows[:10]`,
    });
    if (g && v) {
      out.push({
        id: 'total-plain',
        group: 'Summarise',
        template: 'Total {value} by {group}',
        blurb: 'Adds up one column, grouped by another.',
        params: [tableParam(), col('value', 'Column to total', v.name), col('group', 'Group by', g.name)],
        build: (val) =>
          `totals = {}\n` +
          `for r in tables[${q(val.table)}]:\n` +
          `    key = r[${q(val.group)}]\n` +
          `    totals[key] = totals.get(key, 0) + (r[${q(val.value)}] or 0)\n\n` +
          `[{${q(val.group)}: k, "Total": v} for k, v in sorted(totals.items())]`,
      });
    }
    return out;
  }

  out.push({
    id: 'peek',
    group: 'Look at the data',
    template: 'See the first few rows of {table}',
    blurb: 'Shows the top 20 rows — the quickest way to check the file loaded correctly.',
    params: [tableParam()],
    build: (val) => `${ref(ctx, val.table)}.head(20)`,
  });

  out.push({
    id: 'shape',
    group: 'Look at the data',
    template: 'How big is {table}, and what is missing?',
    blurb: 'Row and column counts, plus how many blanks each column has.',
    params: [tableParam()],
    build: (val) => {
      const r = ref(ctx, val.table);
      return `print(${r}.shape[0], "rows ×", ${r}.shape[1], "columns")\n${r}.isna().sum().rename("blanks").to_frame()`;
    },
  });

  out.push({
    id: 'describe',
    group: 'Look at the data',
    template: 'Summary statistics for {table}',
    blurb: 'Count, average, smallest and largest for every numeric column.',
    params: [tableParam()],
    build: (val) => `${ref(ctx, val.table)}.describe().reset_index()`,
  });

  if (g) {
    out.push({
      id: 'count-by',
      group: 'Summarise',
      template: 'Count rows by {group}',
      blurb: 'How many rows fall under each value — the fastest check on a category column.',
      params: [tableParam(), col('group', 'Group by', g.name)],
      build: (val) =>
        `${ref(ctx, val.table)}[${q(val.group)}].value_counts().rename_axis(${q(val.group)}).reset_index(name="Rows")`,
    });
  }

  if (g && v && hasNumber) {
    out.push({
      id: 'total-by',
      group: 'Summarise',
      template: 'Total {value} by {group}',
      blurb: 'The group-and-add-up step behind most reconciliations.',
      params: [tableParam(), col('value', 'Column to total', v.name, ['number']), col('group', 'Group by', g.name)],
      build: (val) =>
        `(${ref(ctx, val.table)}\n` +
        `    .groupby(${q(val.group)}, as_index=False)[${q(val.value)}]\n` +
        `    .sum()\n` +
        `    .sort_values(${q(val.value)}, ascending=False))`,
    });

    out.push({
      id: 'pct-of-total',
      group: 'Summarise',
      template: '{value} by {group}, with % of total',
      blurb: 'Adds a percentage-of-total column next to each group.',
      params: [tableParam(), col('value', 'Column to total', v.name, ['number']), col('group', 'Group by', g.name)],
      build: (val) =>
        `summary = ${ref(ctx, val.table)}.groupby(${q(val.group)}, as_index=False)[${q(val.value)}].sum()\n` +
        `summary["% of total"] = (summary[${q(val.value)}] / summary[${q(val.value)}].sum() * 100).round(1)\n` +
        `summary.sort_values("% of total", ascending=False)`,
    });

    out.push({
      id: 'top-10',
      group: 'Filter and sort',
      template: 'Top 10 rows by {value}',
      blurb: 'The largest values, biggest first.',
      params: [tableParam(), col('value', 'Column to rank by', v.name, ['number'])],
      build: (val) => `${ref(ctx, val.table)}.nlargest(10, ${q(val.value)})`,
    });

    const second = t.columns.find((c) => c.name !== g.name && c.name !== v.name);
    if (second) {
      out.push({
        id: 'pivot',
        group: 'Summarise',
        template: 'Pivot: {group} down, {across} across, {value} totalled',
        blurb: 'A cross-tab of totals — the spreadsheet pivot table, in one step.',
        params: [
          tableParam(),
          col('group', 'Rows', g.name),
          col('across', 'Columns', second.name),
          col('value', 'Values', v.name, ['number']),
        ],
        build: (val) =>
          `(${ref(ctx, val.table)}\n` +
          `    .pivot_table(index=${q(val.group)}, columns=${q(val.across)}, values=${q(val.value)},\n` +
          `                 aggfunc="sum", fill_value=0)\n` +
          `    .reset_index())`,
      });
    }

    out.push({
      id: 'filter',
      group: 'Filter and sort',
      template: 'Rows where {value} is above a number',
      blurb: 'Change the number in the code to whatever threshold you need.',
      params: [tableParam(), col('value', 'Column to test', v.name, ['number'])],
      build: (val) => {
        const r = ref(ctx, val.table);
        return `threshold = 0\n${r}[${r}[${q(val.value)}] > threshold]`;
      },
    });
  }

  out.push({
    id: 'blanks',
    group: 'Filter and sort',
    template: 'Rows in {table} with something missing',
    blurb: 'Every row that has a blank in any column — usually the first thing to fix.',
    params: [tableParam()],
    build: (val) => {
      const r = ref(ctx, val.table);
      return `${r}[${r}.isna().any(axis=1)]`;
    },
  });

  if (g) {
    out.push({
      id: 'dupes',
      group: 'Filter and sort',
      template: 'Duplicate {group} values',
      blurb: 'Shows every row whose key appears more than once.',
      params: [tableParam(), col('group', 'Key column', g.name)],
      build: (val) => {
        const r = ref(ctx, val.table);
        return `${r}[${r}.duplicated(${q(val.group)}, keep=False)].sort_values(${q(val.group)})`;
      },
    });
  }

  if (t2 && t2.columns.length) {
    const shared = t.columns.find((c) => t2.columns.some((c2) => c2.name === c.name));
    const key = shared?.name ?? t.columns[0].name;
    const pair = (): SnippetParam[] => [
      tableParam(),
      tableParam('other', 'Compare with', t2.name),
      col('key', 'Match on', key),
    ];

    out.push({
      id: 'missing-from',
      group: 'Compare tables',
      template: 'Rows in {table} that are missing from {other}',
      blurb: 'Matches the two tables on a key column and keeps what only exists in the first.',
      params: pair(),
      build: (val) =>
        `merged = ${ref(ctx, val.table)}.merge(${ref(ctx, val.other)}, on=${q(val.key)}, how="left",\n` +
        `                        indicator=True, suffixes=("", "_${val.other}"))\n` +
        `merged[merged["_merge"] == "left_only"].drop(columns="_merge")`,
      });

    out.push({
      id: 'matched',
      group: 'Compare tables',
      template: 'Match {table} against {other} on {key}',
      blurb: 'Joins both tables so you can compare their columns side by side.',
      params: pair(),
      build: (val) =>
        `${ref(ctx, val.table)}.merge(${ref(ctx, val.other)}, on=${q(val.key)}, how="inner",\n` +
        `                        suffixes=("_${val.table}", "_${val.other}"))`,
    });
  }

  if (ctx.charts && g && v && hasNumber) {
    out.push({
      id: 'bar',
      group: 'Charts',
      template: 'Bar chart of {value} by {group}',
      blurb: 'Draws the chart underneath the cell, with Save image next to it.',
      params: [tableParam(), col('value', 'Bar height', v.name, ['number']), col('group', 'One bar per', g.name)],
      build: (val) =>
        `import matplotlib.pyplot as plt\n\n` +
        `summary = ${ref(ctx, val.table)}.groupby(${q(val.group)})[${q(val.value)}].sum().sort_values(ascending=False)\n` +
        `ax = summary.plot(kind="bar", color="#1f5c3d")\n` +
        `ax.set_ylabel(${q(val.value)})\n` +
        `ax.set_title(${q(val.value)} + " by " + ${q(val.group)})\n` +
        `plt.tight_layout()`,
    });

    if (d) {
      out.push({
        id: 'trend',
        group: 'Charts',
        template: '{value} over time, by {date}',
        blurb: 'Totals by month and draws the trend line.',
        params: [tableParam(), col('value', 'Column to total', v.name, ['number']), col('date', 'Date column', d.name)],
        build: (val) =>
          `import matplotlib.pyplot as plt\n\n` +
          `t = ${ref(ctx, val.table)}.copy()\n` +
          `t[${q(val.date)}] = pd.to_datetime(t[${q(val.date)}], errors="coerce")\n` +
          `monthly = t.dropna(subset=[${q(val.date)}]).groupby(t[${q(val.date)}].dt.to_period("M"))[${q(val.value)}].sum()\n` +
          `monthly.index = monthly.index.astype(str)\n` +
          `ax = monthly.plot(marker="o", color="#1f5c3d")\n` +
          `ax.set_ylabel(${q(val.value)})\n` +
          `plt.tight_layout()`,
      });
    }
  }

  return out;
}
