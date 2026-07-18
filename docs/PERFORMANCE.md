# Performance & Memory (Phase 5.2)

Measured in headless Chromium against generated 4-column workbooks. Numbers are
indicative — a real work PC with more RAM tolerates more; a locked-down thin
client tolerates less.

| Rows | .xlsx size | Viewer parse (SheetJS) | DuckDB query (GROUP BY) |
| ---: | ---: | ---: | ---: |
| 50,000 | 7.5 MB | 2.3 s | 148 ms (incl. engine warmup) |
| 200,000 | 31 MB | 8.9 s | 70 ms |
| 500,000 | ~78 MB | tab crashed (OOM) | — |

## Findings

- **SheetJS parse is the bottleneck**, not compute. Parsing scales with size and
  dominates load time. DuckDB queries stay well under 200 ms even at 200k rows —
  the SQL engine handles large data far better than the parse step.
- **A tab can run out of memory well below the old 250 MB cap.** A ~78 MB /
  500k-row file crashed the tab. Parsing holds the raw bytes plus the parsed
  array-of-arrays plus the grid model in memory at once.
- The **virtualized grid stays smooth** regardless of row count (only visible rows
  render); the cost is entirely in parse/hold, not display.

## Limits (enforced in `src/core/validation.ts`)

- `SOFT_SIZE_WARN_BYTES = 25 MB` — above this the user is warned that parsing may
  be slow (parse runs off the main thread, so the UI stays responsive).
- `HARD_SIZE_LIMIT_BYTES = 100 MB` — above this the file is rejected to avoid an
  OOM crash. Lowered from 250 MB after the crash above.

## Guidance

- For very large data, prefer **Query/Pivot** over Viewer/Convert — DuckDB is the
  stronger engine, and SQL narrows the result before it hits the grid.
- Split oversized files first (the Split tool) or filter to the columns/rows you
  need before other operations.
- Future work (not needed yet): streaming parse for the light tier would raise the
  ceiling, but the two-tier design already routes heavy work to DuckDB.
