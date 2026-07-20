# Tech Decisions (Phase 0)

This is the locked set of engineering decisions the rest of the project builds on.
Change these only with a follow-up note here explaining why.

## Goal recap

An all-in-one suite of **light** and **intermediate** Excel tools that runs
**fully offline on work PCs**. No backend, no uploads — every byte of a user's
spreadsheet stays on their machine. Distributed as static files (folder,
internal static host, or PWA install).

## Decision 1 — Fully client-side, static bundle

- No server, no API. The whole app is HTML + JS + CSS + WASM served statically.
- Strong privacy story: data physically cannot leave the PC (enforced by CSP
  `connect-src 'self'`).
- Deploys from a network share, internal static host, or PWA install with no
  admin rights.

## Decision 2 — Two-tier engine strategy

Do **not** force every tool through one runtime. Match the engine to the tool.

| Tier | Tools | Engine | WASM? | Payload |
|------|-------|--------|-------|---------|
| **Light (Tier 1)** | convert, merge, split, dedupe, compare, view | **SheetJS (`xlsx`)** | No (pure JS) | ~1 MB |
| **Intermediate (Tier 2)** | query, pivot, clean+, calc, charts, big files | **DuckDB-WASM** (primary), Pyodide (only if pandas/Python genuinely needed) | Yes | 10–30 MB |

Rationale:
- SheetJS ships now, is tiny, and covers all the high-demand light tools.
- DuckDB-WASM is smaller and faster than Pyodide for tabular ops, and SQL is a
  natural fit for clean/join/aggregate. Preferred intermediate engine.
- Pyodide is held in reserve for tools that truly need the pandas/numpy
  ecosystem; its ~10–30 MB cost is only paid if such a tool is opened.

## Decision 3 — Lazy-load the heavy tier

The intermediate WASM engine is **never** loaded on startup. It loads on first
use of a Tier-2 tool (dynamic `import()` + separate rollup chunk). Tier-1 users
pay ~1 MB, not ~30 MB.

## Decision 4 — All parsing off the main thread

Spreadsheet parsing is CPU-bound and can freeze the UI. All parse/serialize work
runs in a **Web Worker** (`src/workers/parser.worker.ts`) behind a typed
request/response harness. The main thread only ever touches UI state.

## Decision 5 — Build tooling: Vite + TypeScript (vanilla)

- **Vite** — fast dev, first-class Web Worker + WASM + PWA support, static output.
- **TypeScript** — the parser/worker message contracts are worth typing.
- **No UI framework** — keep the bundle small and the shell dependency-light. A
  framework can be revisited if Tier-2 UIs get complex; not needed for Phase 0/1.
- **vite-plugin-pwa (Workbox)** — auto-generates the offline precache manifest,
  which is exactly what robust offline loading needs.

## Decision 6 — Relative base + strict CSP

- `base: './'` so the bundle runs from any path depth, share, or internal host.
- CSP forbids all external hosts. `script-src` includes `'wasm-unsafe-eval'`
  (required to compile WASM); `connect-src 'self'` guarantees no exfiltration.

## Decision 7 — Native Excel Table extraction from the zip (post-Phase 4)

SheetJS community (`xlsx@0.18.5`) does not expose Excel Tables (ListObjects) on
parse. We extract them ourselves: `fflate.unzipSync` on the `.xlsx` buffer, then
targeted regex over `xl/tables/tableN.xml` (name, `ref` range, columns) mapped to
sheets via the rels chain (`src/core/tables.ts`). The parser worker slices each
table's range so surrounding title/junk cells are ignored. Regex is acceptable
here because the schema is small and flat, and Web Workers have no DOMParser.

## Decision 8 — Typed-CSV registration instead of Arrow (CSP)

The first design registered user-configured tables into DuckDB via
`insertArrowTable` (true no-CSV path). **Rejected:** `apache-arrow`'s builders
use `eval`/`new Function`, which our CSP (`script-src 'self' 'wasm-unsafe-eval'`,
deliberately *not* `unsafe-eval`) blocks at runtime. Rather than weaken CSP, we
register through `read_csv_auto(..., all_varchar=true)` and `CAST` each column to
its resolved type in a `CREATE TABLE AS SELECT` (`insertTable` in
`src/core/duckdb.ts`). Same exact-types result, zero new dependencies — and the
block itself is evidence the CSP works.

## Decision 9 — Self-healing service worker

`registerType: 'autoUpdate'` alone let an old cached shell survive deploys and
reference removed chunk hashes ("Failed to fetch dynamically imported module").
Fixed with `skipWaiting` + `clientsClaim` + `cleanupOutdatedCaches`, plus a
one-time guarded reload on `vite:preloadError` (`src/main.ts`) and on
chunk-fetch-looking mount failures (`src/app/shell.ts`).

## Decision 10 — Python tier on Pyodide; CSP relaxed to allow it

A Python (pandas) analysis tool was added on **Pyodide** (Python 3.14 in wasm),
lazy-loaded like DuckDB and self-hosted under `/pyodide/`
(`scripts/pyodide-assets.mjs` stages core from node_modules and best-effort
downloads the pandas wheel set — CI always has them; an offline dev box falls
back to pure Python and the tool degrades gracefully). Spike-verified: Pyodide's
Emscripten glue **requires `eval`**, so `script-src` now includes
`'unsafe-eval'` — an explicit, user-approved tradeoff documented in
`docs/SECURITY.md`; `connect-src 'self'` (the exfiltration block) is unchanged
and CI-enforced. The worker exposes each registered table as
`tables["name"]` (list of dicts) and, when pandas is present, `df_<name>`
DataFrames; user code assigns `result`, which is converted back to a grid.

## Decision 11 — Jupyter-style notebook runner + Agg charts

The Python tool became a **notebook**: cells with persistent globals (already a
property of the Pyodide worker), Jupyter display semantics (per-cell
stdout/stderr capture via `setStdout`, last-expression display via an `ast`
split of the final `Expr`), outputs classified as DataFrame→grid,
matplotlib figure→PNG (`Agg` backend + `savefig`→base64 — no interactive
backend, which suits a static, offline app), else `repr`. Markdown cells use a
dependency-free regex renderer (input HTML-escaped first). Notebooks save/load
as **nbformat 4** (`src/core/notebook.ts`) so files round-trip with real
Jupyter. matplotlib and its wheel set ride the same best-effort CI staging as
pandas (`scripts/pyodide-assets.mjs`); each capability degrades independently
when wheels are absent.

## Open risks carried into later phases

1. **Deployment on locked-down PCs** — CSP overrides, `file://` WASM restrictions,
   or blocked service workers. *Validated by the Phase 0 spike; must be re-checked
   on a real target machine.*
2. **Excel fidelity** — no library round-trips 100% of Excel (VBA, pivot caches,
   some conditional formatting). Acceptable for a tools suite; flag per-tool.
3. **Browser memory ceiling** (~2–4 GB) — multi-million-row files can OOM.
   DuckDB-WASM handles large data best; document limits in Phase 5.
