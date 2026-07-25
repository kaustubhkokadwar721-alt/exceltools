# ExcelTools

An **offline, all-in-one suite of spreadsheet tools** that runs fully in the
browser on work PCs. No backend, no uploads — every file is processed on the
user's machine. Deployable as static files, an offline zip, or an installable
PWA. Built for accountants and finance teams, not engineers.

> **Status:** Phases 0–4 complete; Phase 5 hardening mostly done (tests, CI,
> security, performance, fidelity — only the real-PC pilot remains). Nine tools
> live, plus native Excel Table import. 106 unit + 39 E2E tests in CI.
> See [`docs/`](docs/).

## Live app

- **App:** https://kaustubhkokadwar721-alt.github.io/exceltools/
- **WASM capability spike:**
  https://kaustubhkokadwar721-alt.github.io/exceltools/spike/wasm-spike.html
  (also runnable without Pages via githack:
  https://raw.githack.com/kaustubhkokadwar721-alt/exceltools/main/spike/wasm-spike.html)

The suite depends on WebAssembly, Web Workers, service workers and the File API
being allowed on the target machine. The spike is a self-contained probe that
reports PASS/FAIL for each and never uploads anything — run it on a target PC
before rolling out. Details: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Why

Corporate environments often forbid uploading spreadsheets to online tools. This
suite does everything **client-side** — enforced by a strict CSP
(`connect-src 'self'`), so data physically cannot leave the PC. That claim is
**tested in CI**: an E2E spec exercises the tools (including the SQL engine) and
fails if any request leaves the origin ([`docs/SECURITY.md`](docs/SECURITY.md)).

## Tools

| Tool | What it does |
|------|--------------|
| **Convert** | A sheet **or a native Excel Table** → CSV / TSV / JSON / Markdown / HTML / XLSX |
| **Merge** | Combine files — stack rows (aligned by column name) or keep each as a sheet |
| **Split** | Split a sheet into many files by column value or row count → one `.zip` |
| **Compare** | Diff two sheets on a key column: added / removed / changed / unchanged |
| **Clean** | Trim, collapse spaces, fix case, numbers-from-text, drop blank rows/cols |
| **Dedupe** | Remove duplicate rows by chosen key columns, keeping first or last |
| **Query (SQL)** | *(SQL engine)* Stage, rename and register sheets/tables, then run SQL — joins, filters, aggregation |
| **Python notebook** | *(Python engine)* Notebook cells in the browser — pandas, matplotlib charts, `.ipynb` save/load, no Python install. Built for people who don't write Python: see below |
| **Pivot** | *(SQL engine)* Group-by + aggregate summaries (Sum/Avg/Count/Min/Max) |

### Query workflow (built for non-engineers)

1. Drop files. Each sheet — or each **native Excel Table** (ListObject), detected
   with its real name, exact range and columns — is **staged**: untick what you
   don't want, rename tables, and for Excel Tables pick columns and set types
   (or *skip type detection* to import everything as text). Then **Register**.
2. A **sticky schema rail** beside the SQL editor shows every table with its
   columns, real DuckDB types and row counts — always visible while writing SQL.
3. **Copy schema for AI** copies a plain-text schema preamble. Paste it into any
   AI assistant with a request in plain English ("give me department totals"),
   paste the SQL it writes back into the editor, and run.

### Python notebook, for people who don't write Python

The engine is Pyodide; the work went into the parts that decide whether an
accountant can actually use it.

- **Nothing to type to start.** An empty notebook shows a list of tasks —
  *total by category*, *rows missing from another table*, *duplicates*, *a bar
  chart* — and each one inserts working code **written with your own column
  names**, then runs it. Edit it afterwards; nothing is locked.
- **The tasks are adjustable, not fixed.** Each one reads as a sentence with
  its columns as dropdowns — *Total ⌄PrimaryAmount by ⌄Status* — so wanting it
  *by Entity instead* is a dropdown, not a Python edit. With several files
  loaded you can point a step at a different table the same way.
- **Errors in English.** A failed cell says *"There is no column called
  'Amout'. Did you mean 'Amount'?"* — the traceback is folded away behind
  *Technical details*. Around twenty of the failures that actually happen
  (text in a number column, a cell that hasn't been run, a mismatched join key,
  reading files from disk) are translated (`src/core/pyerrors.ts`).
- **Your results are saved, not just your code.** `.ipynb` files carry their
  tables (`text/html` plus a lossless ExcelTools mime) and charts
  (`image/png`), so reopening one shows the results without re-running — and it
  still opens in real Jupyter.
- **Results go back to Excel.** Every table result carries **Copy** (pastes
  into a spreadsheet as cells, not one blob), **CSV** and **Excel**; charts
  carry **Save image**. **Export** puts *every* table result into one workbook,
  a sheet per step — the thing you actually hand over. A result you can see but
  can't take anywhere gets retyped, and retyping is where errors come from.
- **Sort a result by clicking its header** — ascending, descending, then back
  to the original order. Blanks sink to the bottom either way, because missing
  data is not the smallest value.
- **An empty result says so.** A filter that matches nothing shows *"No rows.
  The step ran without error — nothing matched"*, not a bare grid that looks
  broken. For a reconciliation, nothing is often the answer you wanted.
- **Name the analysis.** The name rides inside the `.ipynb` and names every
  file it produces, so *Q1 GST reconciliation.ipynb* beats `notebook.ipynb`
  when someone opens the folder in six months.
- **Recovery knows what it needs.** A restored draft remembers the tables its
  code refers to, tells you so on the staging screen, and pre-fills those names
  when you re-add the files — so the restored steps run instead of failing on a
  table that got named differently.
- **Figures read like figures.** Numeric columns in a result are grouped and
  right-aligned in your own locale (`16,43,552` on an Indian machine,
  `1,643,552` on a US one), with tabular digits so a column can be read down
  and a stray order of magnitude stands out. Display only — exports carry the
  raw values.
- **Results are tables, not `repr`.** A plain Python list of dicts, list of
  rows, or a dict of totals renders as a grid with exports — you don't need
  pandas to get a readable answer.
- **The chrome gets out of the way.** Once tables are registered, the drop
  area shrinks to a one-line summary of what's loaded and the heading goes
  compact — about 250px of screen back, reversible with *Add more files*.
- **Fold anything.** Collapse a cell's code (its first line stays as a label)
  or its results; the state round-trips through the same `.ipynb` fields
  Jupyter uses. Errors are never folded away.
- **Crash recovery, and undo.** Work is kept in this browser as you type and
  offered back if the tab dies; a deleted cell leaves an **Undo** in the gap it
  came from. Nothing leaves the device.
- **Add a step where you are.** Hovering a cell reveals *＋ Code*, *＋ Note*
  and *⧉ Duplicate* in the gap below it, so building in the middle of a
  notebook doesn't mean adding at the end and pressing ↑ four times.
- **A Stop button that works**, implemented honestly: it restarts the engine and
  re-registers your tables, and tells you the variables are gone.
- **Click a column name** in the right-hand list to drop its exact spelling into
  your code — no transcribing headings with trailing spaces.
- **In memory** tab shows every table and value Python is holding; the column
  list filters when a table is wide.
- Colour is semantic and always paired with text: a cell's left stripe is green
  when it ran, amber while running, red when it failed; results are labelled
  and tinted by type (printed, table, chart, error).
- Syntax highlighting, auto-indent, bracket closing, comment toggling and
  Jupyter's keyboard shortcuts, in ~200 lines and **zero new dependencies**.
- The toolbar stays pinned while you scroll, so **Stop** is always reachable,
  and **Clear results** strips every output before you share the file.

Why not embed JupyterLite (official, Pyodide-based, also static files)? It
can't see your workbook — it owns its own kernel behind its own virtual
filesystem, so you'd export a file and re-import it into a second app — and its
JupyterLab UI assumes a user who knows what a kernel is. Full reasoning in
[`docs/TECH_DECISIONS.md`](docs/TECH_DECISIONS.md#decision-12--build-the-notebook-dont-embed-jupyterlite).

## Architecture

Two-tier engine strategy — match the engine to the tool:

| Tier | Tools | Engine | Loaded |
|------|-------|--------|--------|
| **Light** | convert, merge, split, clean, dedupe, compare | SheetJS (`xlsx`) | up front (small) |
| **SQL engine** | query, pivot | DuckDB-WASM | lazily on first use, then cached offline |
| **Python engine** | python notebook | Pyodide (Python 3.14 + pandas + matplotlib) | lazily on first use, then cached offline |

> The Python engine required adding `'unsafe-eval'` to the CSP (Pyodide's
> Emscripten glue evals at init). The no-exfiltration guarantee
> (`connect-src 'self'`) is unchanged and CI-enforced — rationale in
> [`docs/SECURITY.md`](docs/SECURITY.md).

- All spreadsheet parsing runs in a **Web Worker** — the UI never freezes.
- Each tool is a lazily-loaded chunk; the ~40 MB DuckDB engine is excluded from
  the PWA precache and runtime-cached on first Query/Pivot use, so light-tool
  users never download it (precache is ~760 KiB — app code, styles and fonts).
- **Native Excel Tables** are extracted directly from the xlsx zip
  (`src/core/tables.ts`) since SheetJS doesn't surface them; tables register into
  DuckDB with exact per-column types via a typed-CSV load
  (Arrow was rejected: its codegen needs `eval`, which our CSP forbids).
- The service worker **self-heals across deploys** (`skipWaiting` +
  `clientsClaim` + `cleanupOutdatedCaches`), and a stale lazy-chunk fetch
  triggers one guarded auto-reload — returning users always get the current app.

Full rationale: [`docs/TECH_DECISIONS.md`](docs/TECH_DECISIONS.md).

## Quality

- **106 unit tests** (Vitest) over the pure modules — transform, validation, zip,
  tables, source, plus the notebook's `.ipynb` round-trip (results included),
  error translation, recipe generation, draft storage and syntax highlighting —
  and **39 E2E tests** (Playwright): one per tool, Excel-Table import, staged
  rename + schema, a **no-external-requests privacy guard**, and the notebook's
  save/reopen, recovery, recipes and plain-English errors.
- CI (`.github/workflows/test.yml`) runs typecheck + unit + E2E on every PR and
  push to `main`; deploys only happen from `main`.
- Measured performance limits (soft warn 25 MB, hard cap 100 MB) —
  [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
- Documented format-fidelity boundaries — [`docs/FIDELITY.md`](docs/FIDELITY.md).
- Security & privacy attestation — [`docs/SECURITY.md`](docs/SECURITY.md).
- **Approval pack for a reviewing partner and an IT administrator** —
  [`docs/SECURITY-APPROVAL.md`](docs/SECURITY-APPROVAL.md): plain-English risk
  register, checks anyone can run in fifteen minutes without reading code, and a
  disclosed open issue (the `xlsx` advisories, with the one command that closes
  them).

## Develop

```bash
npm install
npm run dev        # dev server
npm run build      # → dist/ (static, self-contained)
npm run preview    # serve dist/ locally; test PWA + offline in DevTools
npm run test       # 106 unit tests (Vitest)
npm run test:e2e   # 39 E2E tests (Playwright, against the production build)
npm run package    # → exceltools-offline.zip (offline distributable)
npm run typecheck
```

## Deployment

**GitHub Pages (automatic):** `.github/workflows/deploy.yml` builds and
publishes on every push to `main`. One-time setup if forking: Settings → Pages →
Source → **GitHub Actions**.

**Offline distributable:** `npm run package` bundles the app, the capability
spike, and a zero-dependency local-server launcher into
`exceltools-offline.zip` (~16 MB). On a target PC: unzip, run `python serve.py`
(or `node serve.mjs`), and the full suite runs at `http://127.0.0.1:8000/` — no
internet, no install. The build uses a relative base, so any internal static
host or network share also works. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Design

Warm "register" theme — a left sidebar (brand, tier-grouped nav, engine +
privacy cards) and one working surface. Typography pairs **Newsreader** (serif
display), **Instrument Sans** (interface) and **Spline Sans Mono** (data/IDs);
all three **self-hosted** (offline-safe, CSP-clean). Colour is semantic: green =
primary action / trust, gold = the SQL-engine tier and review, red = error —
always paired with text. Data grids auto-fit column widths and support
drag-to-resize. Verified at desktop, laptop, tablet and 390 px mobile with no
horizontal overflow.

## Roadmap

- **Phases 0–4** — ✅ foundation, shell, six light tools, DuckDB tier, design
  system, in-app help, offline packaging
- **Phase 5** — hardening ✅ (tests, CI gate, security attestation, measured
  perf limits, fidelity docs) · **remaining:** real-PC spike + pilot + v1.0 —
  see [`docs/PHASE5-PLAN.md`](docs/PHASE5-PLAN.md)
- **Later** — extending the table/column setup (`SourceSpec`) to the remaining
  tools
