# ExcelTools

An **offline, all-in-one suite of spreadsheet tools** that runs fully in the
browser on work PCs. No backend, no uploads — every file is processed on the
user's machine. Deployable as static files, an offline zip, or an installable
PWA. Built for accountants and finance teams, not engineers.

> **Status:** Phases 0–4 complete; Phase 5 hardening mostly done (tests, CI,
> security, performance, fidelity — only the real-PC pilot remains). Nine tools
> live, plus native Excel Table import. 34 unit + 12 E2E tests in CI.
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
| **Viewer** | Open and browse any spreadsheet without Excel |
| **Convert** | A sheet **or a native Excel Table** → CSV / TSV / JSON / Markdown / HTML / XLSX |
| **Merge** | Combine files — stack rows (aligned by column name) or keep each as a sheet |
| **Split** | Split a sheet into many files by column value or row count → one `.zip` |
| **Compare** | Diff two sheets on a key column: added / removed / changed / unchanged |
| **Clean** | Trim, collapse spaces, fix case, numbers-from-text, drop blank rows/cols |
| **Dedupe** | Remove duplicate rows by chosen key columns, keeping first or last |
| **Query (SQL)** | *(SQL engine)* Stage, rename and register sheets/tables, then run SQL — joins, filters, aggregation |
| **Python notebook** | *(Python engine)* Jupyter-style cells in the browser — pandas, matplotlib charts, `.ipynb` save/load, no Python install |
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

## Architecture

Two-tier engine strategy — match the engine to the tool:

| Tier | Tools | Engine | Loaded |
|------|-------|--------|--------|
| **Light** | view, convert, merge, split, clean, dedupe, compare | SheetJS (`xlsx`) | up front (small) |
| **SQL engine** | query, pivot | DuckDB-WASM | lazily on first use, then cached offline |
| **Python engine** | python notebook | Pyodide (Python 3.14 + pandas + matplotlib) | lazily on first use, then cached offline |

> The Python engine required adding `'unsafe-eval'` to the CSP (Pyodide's
> Emscripten glue evals at init). The no-exfiltration guarantee
> (`connect-src 'self'`) is unchanged and CI-enforced — rationale in
> [`docs/SECURITY.md`](docs/SECURITY.md).

- All spreadsheet parsing runs in a **Web Worker** — the UI never freezes.
- Each tool is a lazily-loaded chunk; the ~40 MB DuckDB engine is excluded from
  the PWA precache and runtime-cached on first Query/Pivot use, so light-tool
  users never download it (precache stays < 700 KiB).
- **Native Excel Tables** are extracted directly from the xlsx zip
  (`src/core/tables.ts`) since SheetJS doesn't surface them; tables register into
  DuckDB with exact per-column types via a typed-CSV load
  (Arrow was rejected: its codegen needs `eval`, which our CSP forbids).
- The service worker **self-heals across deploys** (`skipWaiting` +
  `clientsClaim` + `cleanupOutdatedCaches`), and a stale lazy-chunk fetch
  triggers one guarded auto-reload — returning users always get the current app.

Full rationale: [`docs/TECH_DECISIONS.md`](docs/TECH_DECISIONS.md).

## Quality

- **34 unit tests** (Vitest) over the pure transform/validation/zip/table/source
  modules and **12 E2E tests** (Playwright) — one per tool plus Excel-Table
  import, staged rename + schema, and a **no-external-requests privacy guard**.
- CI (`.github/workflows/test.yml`) runs typecheck + unit + E2E on every PR and
  push to `main`; deploys only happen from `main`.
- Measured performance limits (soft warn 25 MB, hard cap 100 MB) —
  [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
- Documented format-fidelity boundaries — [`docs/FIDELITY.md`](docs/FIDELITY.md).
- Security & privacy attestation — [`docs/SECURITY.md`](docs/SECURITY.md).

## Develop

```bash
npm install
npm run dev        # dev server
npm run build      # → dist/ (static, self-contained)
npm run preview    # serve dist/ locally; test PWA + offline in DevTools
npm run test       # 34 unit tests (Vitest)
npm run test:e2e   # 12 E2E tests (Playwright, against the production build)
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

- **Phases 0–4** — ✅ foundation, shell, seven light tools, DuckDB tier, design
  system, in-app help, offline packaging
- **Phase 5** — hardening ✅ (tests, CI gate, security attestation, measured
  perf limits, fidelity docs) · **remaining:** real-PC spike + pilot + v1.0 —
  see [`docs/PHASE5-PLAN.md`](docs/PHASE5-PLAN.md)
- **Later** — extending the table/column setup (`SourceSpec`) to the remaining
  tools
