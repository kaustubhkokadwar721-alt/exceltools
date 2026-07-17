# Deployment & Offline Validation (Phase 0)

The single biggest risk in this project is **not** the spreadsheet code — it's
whether the app loads and runs on a locked-down corporate PC with no network.
This document is the checklist to prove that on a real target machine.

## How the app is meant to be delivered

The production build (`npm run build`) emits a self-contained `dist/` folder of
static files. Three supported delivery modes, in order of preference:

1. **Internal static host** (recommended) — copy `dist/` behind any internal web
   server (IIS virtual dir, nginx, a shared `\\server\tools\exceltools` served
   over HTTP). Enables the service worker → true offline PWA + installable.
2. **PWA install** — from the internal host, users click "Install" and get a
   desktop app that works with the network cable unplugged.
3. **Direct folder / `file://`** — open `dist/index.html` from a share or USB.
   Works, but service workers and some WASM features are restricted under
   `file://`; treat as fallback only.

## Why an internal host beats `file://`

- Service workers require a secure context (`https://` or `http://localhost` /
  trusted internal origins) — they do **not** run from `file://`.
- Some browsers block `WebAssembly.instantiateStreaming` and worker module
  loading from `file://`.
- CSP behaves more predictably over HTTP(S).

If an internal host is impossible, the app still degrades to a working (non-PWA,
online-cache-less) mode from `file://`, but validate this explicitly.

## Phase 0 validation checklist (run on a REAL work PC)

Use `spike/wasm-spike.html` — a single self-contained page that exercises every
risky capability. Copy it to the target machine and open it. It reports PASS/FAIL
for each check on-screen. Verify:

- [ ] Page loads at all (CSP not blocking inline bootstrap)
- [ ] **WebAssembly compiles** (`WebAssembly.instantiate` of a tiny module)
- [ ] **Web Worker** spawns and round-trips a message
- [ ] **Worker + WASM together** (compile WASM inside the worker)
- [ ] **Service worker** registers (only meaningful over http/https)
- [ ] **File API** — pick a local `.xlsx`, read bytes, no upload
- [ ] **Blob download** — generate a file and save it locally
- [ ] **Cross-Origin isolation** state reported (needed if we ever use SharedArrayBuffer/threads)
- [ ] Browser + version recorded (Edge/Chrome version on the fleet)

## Deciding factors captured from the spike

Record these before Phase 3 (they pick the intermediate engine's threading mode):

| Question | Where it matters |
|----------|------------------|
| Is `crossOriginIsolated === true`? | Enables WASM threads / SharedArrayBuffer (faster DuckDB) |
| Does the SW register on the internal host? | PWA install + offline precache |
| Corporate browser & version? | WASM feature baseline |
| Is `file://` the only option? | Forces non-PWA fallback packaging |

## Build & serve locally (for developers)

```bash
npm install
npm run build          # → dist/
npm run preview        # serve dist/ locally to test the PWA + offline
```

To simulate offline: load `npm run preview`, then in DevTools → Application →
Service Workers, tick "Offline", and reload. The app must still work.
