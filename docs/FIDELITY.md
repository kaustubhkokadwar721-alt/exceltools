# Format Fidelity (Phase 5.4)

What survives a round-trip through ExcelTools, and what does not. The suite is a
**data** toolkit — it works with cell values, not full Excel documents.

## Preserved

- Cell **values** (text, numbers, booleans, dates as read).
- Sheet and column structure; multiple sheets when the target format supports
  them (`.xlsx`).
- Row order.

## Not preserved (known limits)

| Thing | Behaviour | Where it matters |
| --- | --- | --- |
| **Formulas** | Read as their last-computed value, not the formula. | Convert, Merge, Split, Clean, Dedupe |
| **Cell formatting** | Fonts, colours, number formats, conditional formatting are dropped. | All tools |
| **Merged cells** | Flattened; value lands in the top-left, others blank. | All tools |
| **Multiple sheets → CSV/TSV/JSON/MD/HTML** | These formats hold one sheet; only the selected sheet is written. | Convert |
| **Charts, images, pivot caches, macros** | Not read or written. | All tools |
| **Number-as-text nuance** | Clean's "numbers from text" coerces `"1,000"`→`1000` only on explicit opt-in. | Clean |

## Surfaced in the app

The Convert tool carries an in-app note (via `helpNote`): *"Text formats keep
values only — formulas, cell formatting and extra sheets are not preserved."*

## Why this is acceptable

The product is positioned as convert / merge / split / clean / compare / query —
value-level operations. Preserving full Excel document fidelity (styles, formulas,
drawing layer) is out of scope and would require a much heavier engine. For a
tools suite, values-first is the right trade; this document makes the boundary
explicit so users are not surprised.
