# ExcelTools

An **offline, all-in-one suite of spreadsheet tools** that runs fully in the
browser on work PCs. No backend, no uploads — every file is processed on the
user's machine. Deployable as static files or an installable PWA.

> **Status:** Phase 0 (foundation & validation) and Phase 1 (core shell &
> infrastructure) are complete. See [`docs/`](docs/) for the plan.

## Why

Corporate environments often forbid uploading spreadsheets to online tools. This
suite does everything **client-side** — enforced by a strict CSP
(`connect-src 'self'`), so data physically cannot leave the PC.

## Architecture (locked in Phase 0)

Two-tier engine strategy — match the engine to the tool:

| Tier | Tools | Engine | Loaded |
|------|-------|--------|--------|
| **Light** | view, convert, merge, split, clean, compare | SheetJS (`xlsx`) | up front (~small) |
| **Intermediate** | query (SQL), pivot, calc, charts | DuckDB-WASM (Pyodide in reserve) | lazily, on first use |

All spreadsheet parsing runs in a **Web Worker**, so the UI never freezes.
Full rationale in [`docs/TECH_DECISIONS.md`](docs/TECH_DECISIONS.md).

## What's built (Phase 0 + 1)

**Phase 0 — Foundation & Validation**
- Vite + TypeScript static-bundle scaffold, relative base, strict CSP
- PWA shell (service worker precache → true offline)
- `spike/wasm-spike.html` — self-contained capability probe to run on a real
  locked-down PC before rollout ([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md))
- Engine + tooling decisions recorded

**Phase 1 — Core Shell & Infrastructure**
- App shell: sidebar, home tool grid, hash router (works from any path / share)
- File I/O layer: drag-drop + picker, local download helpers
- Unified parser wrapper over `.xlsx/.xls/.csv/.tsv/.ods` via SheetJS
- Typed Web Worker harness (off-main-thread parse/serialize)
- Virtualized data grid (renders only visible rows)
- Central validation + toast error/warning UI
- **Reference tool — Viewer** — exercises the whole stack end to end

Verified end-to-end in headless Chromium: parse a 2-sheet / 200-row workbook
off-thread, virtualized preview, sheet switching, and a full **offline reload**
after cutting the network.

## Develop

```bash
npm install
npm run dev        # dev server
npm run build      # → dist/ (static, self-contained)
npm run preview    # serve dist/ locally; test PWA + offline in DevTools
npm run typecheck
```

## Validate offline deployment (before rollout)

Copy `spike/wasm-spike.html` to a target work PC and open it — it reports
PASS/FAIL for WASM, Web Workers, service workers, File API, and downloads.
See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Roadmap

- **Phase 2** — Light tools (Convert, Merge, Split, Clean/Dedupe, Compare)
- **Phase 3** — Intermediate tools on DuckDB-WASM (Query, Pivot, Charts)
- **Phase 4** — Polish, lazy-loading, offline packaging
- **Phase 5** — Fidelity/perf/security hardening, pilot, rollout

Each planned tool already appears in the shell (marked *soon*) and plugs into
the existing engine via `src/app/registry.ts`.
