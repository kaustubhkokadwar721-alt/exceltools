# Security & Privacy (Phase 5.3)

ExcelTools processes spreadsheets **entirely on the user's device**. This document
states what that means technically and how it is enforced and tested.

## Data flow

- Files are read with the browser File API and processed in-page (Web Workers for
  SheetJS parsing; a DuckDB-WASM worker for Query/Pivot).
- No file, cell value, query, or filename is ever sent to a server — there is no
  server. The app is static files.
- Output is produced in-browser and saved via a local "Save as" download.

**Attested by test:** `tests/e2e/privacy.spec.ts` exercises the light and
intermediate tiers (including loading the DuckDB engine and running a query) and
fails if *any* network request leaves the origin. It runs in CI on every PR.

## Content Security Policy

Set in `index.html` and served with the app:

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Same-origin only baseline |
| `script-src` | `'self' 'wasm-unsafe-eval' 'unsafe-eval'` | `wasm-unsafe-eval` compiles WebAssembly; `'unsafe-eval'` is required by the Python engine (see below) |
| `style-src` | `'self' 'unsafe-inline'` | App styles; inline needed for dynamic UI |
| `worker-src` | `'self' blob:` | Parser/DuckDB workers |
| `img-src` | `'self' data: blob:` | Inline icons and generated previews |
| `connect-src` | `'self'` | **Blocks all outbound fetch/XHR/WebSocket to other origins** |
| `object-src` | `'none'` | No plugins |
| `base-uri` | `'self'` | Prevents base-tag hijacking |

`connect-src 'self'` is the load-bearing line: even if a dependency tried to phone
home, the browser would block it.

**CSP proven in practice:** during the Excel-Table feature we attempted to use
`apache-arrow` for DuckDB registration; its code generation calls
`eval`/`new Function`, and the browser blocked it under the then-strict policy
(*"Refused to evaluate a string as JavaScript"*). We kept the CSP and switched to
a typed-CSV path instead (see `docs/TECH_DECISIONS.md`, Decision 8) — the policy
is not decorative.

### The `'unsafe-eval'` tradeoff (Python engine)

Adding the Python tool required `'unsafe-eval'`: Pyodide's Emscripten glue
evaluates strings at engine init (`ASM_CONSTS = eval(...)`) and cannot run
without it — verified by a spike that failed under the strict policy and passed
with the relaxation. Accepted deliberately, with these boundaries:

- **The privacy guarantee is unchanged.** `connect-src 'self'` still blocks all
  outbound traffic, and the CI no-exfiltration E2E keeps enforcing it.
- `script-src 'self'` still forbids loading any third-party script.
- What `'unsafe-eval'` concedes: if an XSS injection existed, injected code
  could use eval. The app renders all cell content HTML-escaped, has no server,
  and accepts no user HTML — the injection surface is minimal.

## Storage & caching

- **No user data is persisted.** Files live only in memory for the duration of a
  task. Nothing is written to `localStorage`, `sessionStorage`, IndexedDB, or
  cookies.
- The service worker (Workbox, `vite.config.ts`) caches **only application assets
  and the DuckDB engine** — never user files. Precache globs match app code,
  styles, fonts and icons; `runtimeCaching` matches the DuckDB chunk/wasm only.
- Sensitive values never appear in URLs (hash routing carries only tool ids).

## Dependencies (runtime)

All self-hosted; none loaded from a CDN at runtime.

| Package | Pinned | Role |
| --- | --- | --- |
| `xlsx` (SheetJS) | `0.18.5` | Parse/serialize spreadsheets |
| `fflate` | `^0.8.2` | Zip multi-file outputs |
| `@duckdb/duckdb-wasm` | `^1.29.0` | In-browser SQL engine |

Fonts (Spectral, Hanken Grotesk) and icons are bundled locally with their OFL /
Lucide licences in `docs/licenses/`.

## Regression guards

- CI runs unit tests + the no-network E2E on every PR (`.github/workflows/test.yml`).
- Any change that adds an external request, weakens the CSP, or persists user data
  should update this document in the same change — and will trip the privacy test
  if it introduces off-origin traffic.
