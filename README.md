# ExcelTools

An **offline, all-in-one suite of spreadsheet tools** that runs fully in the
browser on work PCs. No backend, no uploads — every file is processed on the
user's machine. Deployable as static files or an installable PWA.

> **Status:** Phases 0–3 complete. Nine tools live and verified — six light-tier
> (SheetJS) and two intermediate-tier (DuckDB-WASM). See [`docs/`](docs/).

## Live app & WASM capability spike

> A GitHub `blob/…` link only *shows* a file's source — it doesn't run it. Use a
> link that **serves** the page.

**Run the spike right now (no setup):** served live via githack —
https://raw.githack.com/kaustubhkokadwar721-alt/exceltools/main/spike/wasm-spike.html

**Permanent links (after enabling GitHub Pages, one-time — see below):**

- **App:** https://kaustubhkokadwar721-alt.github.io/exceltools/
- **WASM capability spike:**
  https://kaustubhkokadwar721-alt.github.io/exceltools/spike/wasm-spike.html

The whole suite depends on WebAssembly, Web Workers, service workers and the
File API being allowed on the target machine. The spike is a self-contained
probe that reports PASS/FAIL for each and never uploads anything — run it on a
target PC before rolling out. What it checks and how to read the results:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Publishing (GitHub Pages)

`.github/workflows/deploy.yml` builds the static bundle and publishes it to
Pages on every push to `main`.

**One-time setup (required — the workflow can't do this itself):** in the repo,
open **Settings → Pages → Build and deployment → Source** and select
**GitHub Actions**. Then re-run the latest *Deploy to GitHub Pages* action (or
push any commit to `main`). Until Pages is enabled this way, the deploy job
fails at `configure-pages` with `Get Pages site failed … Not Found` — that error
means only "Pages isn't enabled yet", not a build problem.

The build uses a relative base, so it also works from any static host, network
share, or offline PWA install — Pages is just the easiest way to get a running
link.

## Why

Corporate environments often forbid uploading spreadsheets to online tools. This
suite does everything **client-side** — enforced by a strict CSP
(`connect-src 'self'`), so data physically cannot leave the PC.

## Architecture (locked in Phase 0)

Two-tier engine strategy — match the engine to the tool:

| Tier | Tools | Engine | Loaded |
|------|-------|--------|--------|
| **Light** | view, convert, merge, split, clean, dedupe, compare | SheetJS (`xlsx`) | up front (~small) |
| **Intermediate** | query (SQL), pivot, calc, charts | DuckDB-WASM (Pyodide in reserve) | lazily, on first use |

All spreadsheet parsing runs in a **Web Worker**, so the UI never freezes. Each
tool is a lazily-loaded chunk, so the base app stays ~9 KB and a tool's cost is
only paid when it's opened. Full rationale in
[`docs/TECH_DECISIONS.md`](docs/TECH_DECISIONS.md).

## Tools (Phase 2 — all live)

| Tool | What it does |
|------|--------------|
| **Viewer** | Open and browse any spreadsheet without Excel |
| **Convert** | One sheet → CSV / TSV / JSON / Markdown / HTML / XLSX |
| **Merge** | Combine files — stack rows (aligned by column name) or keep each as a sheet |
| **Split** | Split a sheet into many files by column value or row count → one `.zip` |
| **Compare** | Diff two sheets on a key column: added / removed / changed / unchanged |
| **Clean** | Trim, collapse spaces, fix case, numbers-from-text, drop blank rows/cols |
| **Dedupe** | Remove duplicate rows by chosen key columns, keeping first or last |
| **Query (SQL)** | *(intermediate)* Register sheets as tables and run SQL — joins, filters, aggregation |
| **Pivot** | *(intermediate)* Group-by + aggregate summaries (Sum/Avg/Count/Min/Max) |

## What's built

**Phase 0 — Foundation & Validation**
- Vite + TypeScript static-bundle scaffold, relative base, strict CSP
- PWA shell (service worker precache → true offline)
- WASM/worker/SW/File-API capability spike (see above)
- Engine + tooling decisions recorded

**Phase 1 — Core Shell & Infrastructure**
- App shell: sidebar, home tool grid, hash router (works from any path / share)
- File I/O layer: drag-drop + picker, local download helpers
- Unified parser wrapper over `.xlsx/.xls/.csv/.tsv/.ods` via SheetJS
- Typed Web Worker harness (off-main-thread parse/serialize)
- Virtualized data grid (renders only visible rows)
- Central validation + toast error/warning UI

**Phase 2 — Light Tools**
- The seven tools above, each a lazy chunk over the shared off-thread parser
- Pure, testable transforms in `src/core/transform.ts`
  (mergeStack, splitByColumn, splitByRows, diffSheets, dedupeByKeys, cleanSheet)
- Multi-file zip output via `fflate` (loads only with Split)

**Phase 3 — Intermediate Tools (DuckDB-WASM)**
- Query (SQL) and Pivot, running fully in-browser on a lazy-loaded, self-hosted
  DuckDB-WASM engine (`src/core/duckdb.ts`) — no CDN, CSP-clean
- The ~40 MB engine is excluded from precache and runtime-cached on first use,
  so light-tool users never download it (precache stays ~488 KiB)

Every tool has been driven end-to-end in headless Chromium with correct results
and zero console errors, including a full **offline reload** after cutting the
network and an in-browser SQL `GROUP BY` returning correct per-group aggregates.

## Develop

```bash
npm install
npm run dev        # dev server
npm run build      # → dist/ (static, self-contained)
npm run preview    # serve dist/ locally; test PWA + offline in DevTools
npm run package    # → exceltools-offline.zip (offline distributable)
npm run typecheck
```

## Offline distributable

`npm run package` bundles the built app, the capability spike, and a
zero-dependency local-server launcher into `exceltools-offline.zip` (~16 MB).
On a target PC: unzip, run `python serve.py` (or `node serve.mjs`), and the full
suite runs at `http://127.0.0.1:8000/` — no internet, no install. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Validate offline deployment (before rollout)

Copy [`spike/wasm-spike.html`](spike/wasm-spike.html) to a target work PC and
open it — it reports PASS/FAIL for WASM, Web Workers, service workers, File API,
and downloads. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Roadmap

- **Phase 2** — ✅ Light tools (Convert, Merge, Split, Clean, Dedupe, Compare)
- **Phase 3** — ✅ Intermediate tools on DuckDB-WASM (Query, Pivot) — Charts next
- **Phase 4** — ✅ Polish & packaging — warm register design system, in-app help
  ("How this works" per tool), and an **offline distributable** (`npm run
  package` → `exceltools-offline.zip` with a zero-dependency local launcher).
- **Phase 5** — Hardening, pilot, rollout — see
  [`docs/PHASE5-PLAN.md`](docs/PHASE5-PLAN.md).

## Design

Warm "register" theme — a left sidebar (brand, tier-grouped nav, engine +
privacy cards) and one working surface. Typography pairs **Newsreader** (serif
display), **Instrument Sans** (interface) and **Spline Sans Mono** (data/IDs);
all three are **self-hosted** (offline-safe, CSP-clean). Colour is semantic:
green = primary action / trust, amber (gold) = the SQL-engine tier and review,
red = error — always paired with text. Verified in-browser at desktop, laptop,
tablet and 390px mobile with no horizontal overflow.

Each planned tool already appears in the shell (marked *soon*) and plugs into
the existing engine via `src/app/registry.ts`.
