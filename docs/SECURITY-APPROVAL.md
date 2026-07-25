# ExcelTools — Security Approval Pack

**For:** the reviewing partner, and the IT administrator.
**About:** whether ExcelTools may be used on firm machines with client data.
**Version reviewed:** see `Version stamp` at the end. **Status:** one open issue, disclosed in §5.

This pack is written to be read by someone who does not write software. Part A is
for the partner. Part B is a set of checks the IT administrator can run in about
fifteen minutes, without taking anyone's word for it. Part C is the technical
detail if anyone wants it.

Nothing here asks you to trust a claim you cannot check yourself. Where something
is unproven or unresolved, it says so.

---

## Part A — For the reviewing partner

### A1. What it is, in one paragraph

ExcelTools is a set of spreadsheet tools that runs **inside a web browser on the
user's own machine**. It converts, merges, splits, compares, cleans and de-duplicates
spreadsheets, and offers SQL and Python analysis over them. It is not a website that
receives your files, and it is not an installed application. It is a folder of files
that a browser reads locally.

### A2. The one risk that matters, and how it is addressed

The reason firms ban online spreadsheet tools is **exfiltration**: client data
leaving the machine. ExcelTools addresses this not by policy but by construction.

The application declares a browser-enforced rule (a Content Security Policy) that
permits it to talk to *no network address whatsoever* other than the folder it was
loaded from. This is enforced by the browser itself, not by the application's own
code, so a bug in the application cannot defeat it. There is also no server to send
anything to: the product is a folder of static files.

That claim is **tested automatically on every change**. A test drives the real
application through real work — loading files, running the SQL engine, running
Python — while recording every network request the browser makes. If any request
goes anywhere else, the build fails and the change cannot ship. See §B4 to watch
this yourself.

### A3. What could still go wrong

An honest list. None of these are hypothetical excuses; they are the residual risks
you would be accepting.

| # | Risk | Severity | Position |
|---|------|----------|----------|
| R1 | A **known defect in a third-party spreadsheet-reading library** (see §5) could be triggered by a deliberately malformed file. | Medium | **Open.** Fix available but not yet applied. Details and exact remediation in §5. |
| R2 | The user is **running arbitrary Python and SQL** by design. A user can write a slow or memory-hungry step and hang their own browser tab. | Low | Accepted. It affects one tab, not the machine. There is a Stop button. |
| R3 | The **notebook stores a draft** of your work in the browser's local storage, so a crashed tab does not lose an hour. That is data at rest on the machine. | Low | Disclosed, bounded, and switchable off in the interface. See §B6. |
| R4 | Downloaded results land in the user's **Downloads folder** like any other download, outside the tool's control. | Low | Firm data-handling policy applies as it does to any download. |
| R5 | **Key-person risk.** One person wrote and maintains this. There is no second maintainer today. | Medium | Not a technical risk; a continuity risk. Raised deliberately — see §A5. |
| R6 | **Numerical correctness is asserted by tests, not by an independent validation.** The tests prove the code behaves as written. | Medium | See §A4. This is the risk most relevant to audit work. |
| R7 | If the **hosted** copy is used, the machine fetches the application from GitHub each visit. | Low | Avoidable entirely: use the offline copy (§B2). No client data is involved either way. |

### A4. What this pack does **not** claim

It does not claim the figures are right.

There are 106 automated tests covering the transformation logic and 39 covering the
application end to end. Those prove the software does what its author intended. They
are not an independent reconciliation of ExcelTools output against Excel output on a
body of real firm data — particularly for Indian date formats, lakh/crore separators,
and how the SQL engine converts column types. `docs/FIDELITY.md` states plainly where
the tool deliberately differs from Excel (formulas are read as their last computed
value; merged cells are flattened).

**Recommendation:** if output from this tool will support a workpaper, treat it like
any other tool used in the engagement and require a validation file — a fixed set of
representative firm files with independently agreed expected results, re-run and
signed off at each version. That is a normal control, and it is the single most
useful thing that could be added to this pack.

### A5. Continuity

One person builds, maintains and can fix this. If that person is unavailable, nobody
at the firm can currently patch it. The source is not obscure — it is plain,
commented, and the whole product is a folder of files — but "readable in principle"
is not the same as "someone is on the hook."

Before firm-wide use, it is reasonable to require: a second person able to build and
release it; a fixed version pinned per engagement; and a note of what the tool has
been validated to do.

### A6. What is being asked for

Approval to use ExcelTools on firm machines for firm and client data, subject to:
1. R1 in §A3 being closed, or explicitly accepted in writing (§5 gives the exact fix);
2. a validation file per §A4 before output supports a workpaper;
3. the continuity conditions in §A5.

---

## Part B — For the IT administrator: checks you can run yourself

You do not need to read any code. Each check is a few minutes and tells you something
specific. Do them in order.

### B1. Confirm it installs nothing

Unzip `exceltools-offline.zip` anywhere — the Desktop is fine. Look at what you get:
a folder of files. There is **no installer, no `.exe`, no `.msi`, no driver, no
service, no scheduled task, no registry change, and no administrator prompt.** It
cannot install anything, because nothing in the package is an executable program for
Windows.

**What to conclude:** removing it is deleting a folder. It leaves nothing behind
except the browser's own cache and the draft described in §B6, both of which clear
with the browser's "Clear site data".

### B2. Run it with the network physically disconnected

Inside the unzipped folder is `START-HERE.txt`. Follow it: run `python serve.py`
(or `node serve.mjs`), which starts a small local page server, then open
`http://127.0.0.1:8000/`.

Now **disconnect the network** — pull the cable, turn off Wi-Fi — and use the tool:
drop a spreadsheet in, convert it, run a SQL query, run the Python notebook.
Everything works.

**What to conclude:** it has no dependency on any outside service. It cannot be
sending anything anywhere, because there is nowhere for it to send to and it works
perfectly with nothing to send to.

> A small local server is used only because browsers refuse to run this class of
> feature from a bare file path. It listens on `127.0.0.1` — this machine only — and
> serves the folder it was started in. It is not reachable from the network. You can
> stop it by closing the window.

### B3. Read the network rule yourself

In the unzipped folder, open `index.html` in Notepad. Near the top is a line
beginning `Content-Security-Policy`. Inside it is:

```
connect-src 'self'
```

That instruction tells the browser: this page may open network connections **only**
back to where it came from. The browser enforces it. The page cannot override it.

In the same line you will also see `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`.
The `'unsafe-eval'` looks alarming and deserves an explanation: it is required by the
Python engine, which compiles Python inside the page. It permits the page to run code
**it already has**; it does not permit fetching code from anywhere, which is what
`script-src 'self'` and `connect-src 'self'` forbid. The trade-off is written up in
`docs/SECURITY.md`.

### B4. Watch the network for yourself

Open the tool in Chrome or Edge, press **F12**, choose the **Network** tab, tick
**Preserve log**. Now do a full piece of work: load a file, convert it, run a query,
run a Python step, export the result.

Every line in that list will be a local address (`127.0.0.1`, or the internal host you
serve it from). Nothing else appears — no analytics, no fonts, no cloud, no telemetry.

**What to conclude:** you have directly observed the claim in §A2.

### B5. Check what it is allowed to do in the browser

The tool never asks for camera, microphone, location, notifications, clipboard-read,
or USB. It reads a file **only** when a user actively drops it in or picks it from the
file dialog. It has no ability to browse the machine's disk on its own.

### B6. Check what it leaves on the machine

Two things, both local, both clearable:

1. **A cache of the application's own files** (so it works offline). Application code
   only — never a user's spreadsheet.
2. **A draft of the Python notebook's own contents** — the code and notes the user
   typed, plus small result fragments (charts excluded, tables cut to 50 rows). This
   exists so that a crashed tab does not destroy an hour of work.

To inspect: F12 → **Application** → **Local Storage**. The key is
`exceltools.notebook.draft.v1`.

To turn it off: in the Python notebook, untick **"Keep a draft in this browser"**.
That deletes the stored draft immediately and stops further writes. On a shared or
kiosk machine, untick it.

**No spreadsheet file is ever written to storage by any tool.**

### B7. Check the machine's suitability before rolling out

The package includes a self-contained capability probe: `spike/wasm-spike.html`.
Open it on a target machine. It reports PASS/FAIL for each browser feature the suite
needs, and it uploads nothing. If your managed browser policy blocks one of them, you
will find out here rather than mid-engagement.

### B8. The check that is currently failing

Run this in the source folder if you have Node.js, or ask for the output:

```
npm audit --omit=dev
```

Today it reports **one high-severity advisory** against the spreadsheet-reading
library. Do not skip this; §5 explains exactly what it is, what it can and cannot do
here, and the one command that fixes it.

### B9. Sign-off checklist

| # | Check | Result |
|---|-------|--------|
| B1 | Installs nothing; no admin rights required | ☐ |
| B2 | Works fully with the network disconnected | ☐ |
| B3 | `connect-src 'self'` present in `index.html` | ☐ |
| B4 | Network tab shows only local addresses during real use | ☐ |
| B5 | Requests no device permissions | ☐ |
| B6 | Storage contents understood; draft setting decided | ☐ |
| B7 | Capability probe passes on a target machine | ☐ |
| B8 | Dependency advisory closed or accepted in writing | ☐ |

---

## Part C — Technical detail

### C1. Architecture and trust boundaries

- **Delivery:** static files. No backend, no database, no API, no accounts, no logging.
- **Execution:** all processing happens in the browser tab. Spreadsheet parsing runs
  in a **Web Worker** (a separate thread with no direct access to the page's DOM).
  SQL runs in DuckDB compiled to WebAssembly; Python runs in Pyodide, also
  WebAssembly, in a worker.
- **WebAssembly sandbox:** WASM has no ambient authority. Pyodide's Python sees an
  in-memory filesystem only. `open("C:/...")` from a notebook cell cannot reach the
  real disk — the notebook's own error messages say so, because users try it.
- **The only way data enters** is a user dropping a file or picking one in the file
  dialog. **The only way data leaves** is a download the user triggers.

### C2. Controls

| Control | Mechanism | Enforced by |
|---|---|---|
| No exfiltration | `connect-src 'self'` | Browser |
| No third-party code at runtime | `script-src 'self'`; all dependencies bundled at build; no CDN | Browser + build |
| No inline script | no `'unsafe-inline'` in `script-src` | Browser |
| No plugins/embeds | `object-src 'none'` | Browser |
| Regression-proofed | E2E test fails the build on any cross-origin request | CI |
| Output escaping | one shared `escapeHtml`, unit-tested; DOM built via `textContent` elsewhere | Code + tests |

### C3. Handling of untrusted input

Client spreadsheets and `.ipynb` files are untrusted input, so:

- Cell values, column headings and file names are rendered as **text**, never as
  markup. This was reviewed in preparing this pack and three places were found where
  a file name or a URL fragment was interpolated into HTML; all three were fixed and
  a regression test added (`tests/unit/escaping.test.ts`, plus an end-to-end test that
  a hostile link renders as text).
- When opening a `.ipynb` written elsewhere, the app deliberately **ignores any HTML
  the file carries**. It reads only the plain-text, image and its own structured
  result formats. A notebook cannot bring markup into the page.
- Markdown notes are HTML-escaped before rendering, and the renderer is 20 lines of
  our own code rather than a library.

### C4. Dependencies at runtime

Four, all bundled at build time, none fetched at runtime:

| Package | Version | Role |
|---|---|---|
| `xlsx` (SheetJS) | 0.18.5 | Read/write spreadsheets — **see §5** |
| `@duckdb/duckdb-wasm` | ^1.29.0 | SQL engine |
| `pyodide` | ^314.0.2 | Python engine |
| `fflate` | ^0.8.2 | Zip output |

---

## §5. Open issue — spreadsheet library advisories

**This is the one item in this pack that is not closed. It is stated first and plainly
because a reviewer should not have to find it.**

### What it is

The suite reads spreadsheets with SheetJS (`xlsx`). The version installed from the
public npm registry is **0.18.5**, which carries two published advisories:

- **GHSA-4r6h-8v6p-xvw6** — prototype pollution. A deliberately malformed file can
  corrupt shared JavaScript object state. Fixed upstream in 0.19.3.
- **GHSA-5pgg-2g8v-p4x9** — regular-expression denial of service. A crafted file can
  send the parser into a hang. Fixed upstream in 0.20.2.

`npm audit` reports these as **high severity, "No fix available"**. That phrasing is
misleading and worth understanding: a fix exists, but SheetJS stopped publishing to
npm, so the registry copy is frozen at the last vulnerable version. The npm entry will
never update.

### What it can actually do here

Stated carefully, neither overstated nor waved away. The attack requires a user to
**open a malicious spreadsheet** — which, for an audit firm receiving client files, is
a realistic scenario, not a theoretical one.

- **Data cannot be exfiltrated as a result.** The Content Security Policy blocks all
  outbound connections regardless of what the parser does, and there is no server to
  receive anything. This is the reason the issue is Medium and not Critical.
- **Parsing runs in a Web Worker**, a separate JavaScript realm from the page. Object
  corruption in the worker does not reach the page's own code. It could, in principle,
  affect the output the worker produces — so the meaningful risk is **a silently wrong
  conversion**, not a compromised machine.
- **The denial-of-service case** hangs the worker. The interface stays responsive and
  the tab can be closed. There is no impact beyond that tab.
- **No native code, no disk access, no persistence** is reachable through either issue.
  It cannot install anything or escape the browser.

### How to close it

One command, in the project folder:

```
npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
npm run build && npm test && npm run test:e2e
```

That installs the maintained SheetJS build — from the vendor's own distribution, which
is where SheetJS now publishes — and re-runs the full test suite. Expect `npm audit`
to report clean afterwards.

**This has not been done in the working environment used to prepare this pack,
because its network policy blocks `cdn.sheetjs.com`.** It must be run on a machine
with access to that host and the result re-tested before this item can be marked
closed. Until then, R1 in §A3 stands open.

### If it cannot be closed

If firm policy forbids installing from a non-registry source, the honest options are:
accept the risk in writing on the basis of the bounded impact above; restrict the tool
to files from known sources; or migrate to a different spreadsheet library, which is
a substantial change and should not be decided casually.

---

## Version stamp

| Item | Value |
|---|---|
| Reviewed | 25 July 2026 |
| Tests at review | 106 unit, 39 end-to-end, all passing |
| Open issues | 1 (§5) |
| Fixed while preparing this pack | 3 HTML-injection defects (§C3); unverified build-time downloads; CI token scope; missing security headers on the offline launcher — see `SECURITY-PLAN.md` |
| Not independently validated | numerical correctness vs Excel (§A4) |

Record the exact commit used for any engagement. The claims in this pack apply to that
commit, not to "ExcelTools" in general.

Related: [`SECURITY-PLAN.md`](SECURITY-PLAN.md) (the full audit behind this pack:
threat model, every finding, and the phased remediation plan),
[`SECURITY.md`](SECURITY.md) (technical attestation), [`FIDELITY.md`](FIDELITY.md)
(where output deliberately differs from Excel), [`DEPLOYMENT.md`](DEPLOYMENT.md).
