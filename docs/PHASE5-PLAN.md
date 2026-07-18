# Phase 5 Plan — Hardening, Pilot & Rollout

## Context

Phases 0–4 delivered a working, styled, offline suite of nine tools (SheetJS +
DuckDB-WASM), deployed to GitHub Pages and packageable as an offline zip. What it
does **not** yet have is the evidence a corporate rollout needs: automated tests,
measured performance/memory limits, a written security/privacy attestation,
documented format-fidelity caveats, and a validated pilot on a real locked-down
PC. Phase 5 closes that gap and takes the product to a defensible **v1.0**.

Workstreams are independent enough to run in roughly the order below; each lists
concrete deliverables and the files involved.

**Progress:** 5.1 (tests), 5.2 (performance — `docs/PERFORMANCE.md`, limits
tuned), 5.3 (security), 5.4 (fidelity — `docs/FIDELITY.md` + in-app note), and
5.5 (CI gate) are **done**. Remaining: 5.6 pilot & rollout (needs a real PC).

## Current gaps (baseline)

- **No automated tests.** All verification so far has been manual/headless-driven
  ad hoc. Pure logic in `src/core/transform.ts` and `src/core/validation.ts` is
  untested; tools are only smoke-checked.
- **No CI test gate.** `deploy.yml` builds and ships; nothing runs tests on a PR.
  Its actions also emit Node-20 deprecation warnings.
- **Performance/memory limits are asserted, not measured** (`SOFT_SIZE_WARN_BYTES`
  = 25 MB, `HARD_SIZE_LIMIT_BYTES` = 250 MB in `validation.ts`).
- **Fidelity caveats are undocumented** (SheetJS drops formulas/formatting on
  round-trip; CSV holds one sheet; etc.).
- **Privacy claim is true but unattested** — no test enforces "no external
  requests," and nothing guards against a future regression.

---

## Workstream 5.1 — Automated test suite

**Goal:** lock behaviour so refactors and dependency bumps are safe.

- Add **Vitest** for unit tests of the pure modules (no DOM, fast):
  - `src/core/transform.ts` — `mergeStack`, `splitByColumn`, `splitByRows`,
    `diffSheets`, `dedupeByKeys` (key-based + whitespace/case folding),
    `cleanSheet` (each option + the number-from-text regex edge cases).
  - `src/core/validation.ts` — extension/size/empty rules and messages.
  - `src/core/zip.ts` — round-trip a few entries; unique-name collisions.
- Add **Playwright** E2E, promoting the existing scratch drive scripts into
  committed specs under `tests/e2e/`: one spec per tool asserting a correct
  output (the fixtures and expected values already exist from manual runs).
- Fixtures: commit the small `.xlsx` fixtures used during development to
  `tests/fixtures/`.

**Deliverables:** `vitest.config.ts`, `tests/unit/*.test.ts`, `tests/e2e/*.spec.ts`,
`tests/fixtures/*`, `npm test` + `npm run test:e2e` scripts. Target: transforms at
~100% branch coverage; one green E2E per tool.

## Workstream 5.2 — Performance & memory limits

**Goal:** replace guessed limits with measured ones, documented per tier.

- Benchmark parse + render for 10k / 100k / 1M-row workbooks (light tier) and
  DuckDB query/pivot at the same sizes (intermediate tier); record wall-time and
  peak memory (`performance.memory` where available, plus manual DevTools).
- Find the practical OOM ceiling for each engine in a corporate browser and set
  `SOFT_SIZE_WARN_BYTES` / `HARD_SIZE_LIMIT_BYTES` from data. Consider a higher
  limit on the DuckDB path (it streams better than SheetJS).
- Confirm the virtualized grid stays smooth at the top row counts; add a preview
  cap note if needed.

**Deliverables:** a `docs/PERFORMANCE.md` table (size → time → memory → verdict),
tuned constants in `src/core/validation.ts`, any needed streaming note.

## Workstream 5.3 — Security & privacy review

**Goal:** turn "Private by design" into an attested, regression-guarded claim.

- **Automated no-exfiltration test:** a Playwright spec that exercises every tool
  and fails if any request leaves the origin (the `pkg.mjs` probe already proved
  zero external requests — formalize it). Run it in CI.
- **CSP audit:** confirm `connect-src 'self'` and that `'wasm-unsafe-eval'` is the
  only eval-class allowance; document why each directive exists.
- **Service-worker cache review:** verify only app assets + the DuckDB engine are
  cached (Workbox `runtimeCaching` in `vite.config.ts`) and that **no user file
  data** is ever written to caches, IndexedDB, or localStorage.
- **Dependency audit:** triage `npm audit` (dev-only vs runtime), pin runtime deps
  (`xlsx@0.18.5`, `fflate`, `@duckdb/duckdb-wasm`), and record an SBOM-style list.

**Deliverables:** `docs/SECURITY.md` (data-flow + CSP + cache attestation),
`tests/e2e/no-network.spec.ts`, an audit note.

## Workstream 5.4 — Format fidelity

**Goal:** state clearly what survives a round-trip and what does not.

- Document known SheetJS limits: values-not-formulas, lost cell formatting,
  merged cells flattened, CSV = single sheet, date/number coercion behaviour.
- Add short, honest per-tool fidelity notes in the UI where it matters (e.g. the
  Convert tool: "CSV/JSON keep values, not formulas or formatting"). Reuse the
  existing `helpNote` mechanism in `src/app/registry.ts`.
- Round-trip fixtures with unicode, long numbers, dates, blank rows, and multiple
  sheets in the E2E suite.

**Deliverables:** `docs/FIDELITY.md`, `helpNote` additions, round-trip E2E cases.

## Workstream 5.5 — CI/CD hardening

**Goal:** a PR gate and a clean pipeline.

- New `.github/workflows/test.yml`: on PR + push, run `typecheck`, Vitest, and
  Playwright (install the bundled Chromium once). Block merge on failure.
- Bump `deploy.yml` action versions / Node to clear the Node-20 deprecation.
- Keep the deploy workflow deploying only from `main` after tests pass.

**Deliverables:** `.github/workflows/test.yml`, updated `deploy.yml`.

## Workstream 5.6 — Pilot & rollout

**Goal:** prove it on real hardware, then widen.

1. **Spike on a real locked-down PC** — run `spike/wasm-spike.html` on an actual
   target machine (the long-standing open risk). Record browser/version, CSP
   behaviour, `crossOriginIsolated`, and service-worker registration.
2. **Pilot** — distribute `exceltools-offline.zip` (or an internal host URL) to a
   small group; collect issues against real corporate spreadsheets.
3. **Feedback loop** — fix fidelity/perf issues surfaced by real files.
4. **Rollout** — internal-host deployment + short user guide; announce v1.0.

**Deliverables:** spike results appended to `docs/DEPLOYMENT.md`, a pilot
issue log, a one-page user guide, a tagged `v1.0` release.

---

## Suggested sequence & exit criteria

1. 5.1 tests + 5.5 CI gate (foundation for everything else)
2. 5.3 security attestation (cheap, high-trust, mostly formalizing what exists)
3. 5.2 performance + 5.4 fidelity (needs real files; overlaps the pilot)
4. 5.6 pilot → rollout

**v1.0 is done when:** transforms are unit-tested and green in CI; a no-network
E2E passes; performance/memory limits are measured and documented; fidelity
caveats are written and surfaced; the spike has passed on a real target PC; and a
pilot group has used it against genuine spreadsheets without a blocking issue.
