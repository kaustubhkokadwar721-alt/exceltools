# Security audit and hardening plan

**Scope:** the whole product — the application, the files it consumes, the build
that produces it, and the way it reaches a work PC.
**Objective, in the owner's words:** *can't be easily hacked; won't leak
confidential information; won't harm or create vulnerabilities on a work PC.*

Those three are the right instincts, but they are not the whole attack surface.
A tool can satisfy all three as written and still be compromised — through the
**build pipeline**, before it ever reaches a PC. This audit is therefore not
limited to the three; it works through every place an attacker could stand.

Findings are rated by what an attacker actually achieves, not by how alarming
the name sounds. Everything already fixed is marked and can be verified in the
commit history; everything outstanding has an owner-actionable step.

---

## 1. Threat model — who is attacking, and how

You cannot audit without saying who you are defending against. Five realistic
attackers, in descending order of likelihood for this product:

| # | Attacker | Route in | What they want |
|---|---|---|---|
| T1 | **A malicious or malformed client file** | The user opens a spreadsheet received by email | Code execution in the browser; corrupt the numbers |
| T2 | **A malicious notebook** (`.ipynb`) shared between colleagues | The user opens it and presses Run all | Runs Python of the attacker's choosing |
| T3 | **A crafted link** to the hosted app | Sent by email or chat | Script execution in the app's origin; phishing |
| T4 | **A compromised dependency or build step** | npm, a CDN, a GitHub Action | Arbitrary code in the shipped product, on every machine |
| T5 | **Someone with access to the machine** | Physically, or another local process | Reading data the tool left behind |

T4 is the one non-specialists consistently miss, and it is the one with the
largest blast radius: it puts attacker code on *every* machine at once, signed
with the tool's own legitimacy. Sections 3 and 4 are mostly about T4.

Explicitly **out of scope** (and it should be said rather than implied): a
compromised browser, a compromised Windows install, a browser zero-day, a
malicious browser extension, and anyone with administrator rights on the PC. No
web application can defend against those, and any document claiming otherwise is
overselling.

---

## 2. What is already sound

Verified during this audit rather than assumed. These are the load-bearing
controls, and they are genuinely well-founded:

- **No network egress is possible.** `connect-src 'self'` is enforced by the
  browser, not by application code, and there is no server to receive anything.
  A CI test drives the real app and fails the build if any request leaves the
  origin. This is the single strongest property the product has: it means that
  even a *successful* code-execution attack cannot exfiltrate client data.
- **Processing is isolated.** Spreadsheet parsing, SQL and Python all run in Web
  Workers, off the main thread; the engines are WebAssembly, which has no
  ambient authority. Pyodide's filesystem is in memory — a notebook cell cannot
  read `C:\`. Verified by reading the worker code, not inferred.
- **No dynamic code paths in the app itself.** No `eval`, `new Function`,
  `document.write`, `insertAdjacentHTML`, or `srcdoc` anywhere in `src/`. No
  external URLs in `src/`. (`'unsafe-eval'` in the CSP is required by Pyodide's
  own runtime, not used by application code.)
- **No secrets** in the source or in git history.
- **Untrusted HTML from opened notebooks is never rendered** — the `.ipynb`
  reader deliberately ignores `text/html` from foreign files and takes only
  plain text, images and its own structured format.
- **CI runs on every change**: typecheck, 106 unit tests, 39 end-to-end tests
  including the no-exfiltration guard.

---

## 3. Findings

### FIXED-1 — Attacker-controlled text reached HTML in three places · *was: Medium*

`src/app/shell.ts` interpolated the **URL fragment** into the "Unknown tool"
message; `src/tools/converter.ts` and `src/tools/pivot.ts` interpolated the
**file name** into a loading message. All three reached `innerHTML`.

Attacker T3 could send a crafted link; T1 supplies the file name. The CSP has no
`'unsafe-inline'` in `script-src`, so injected inline handlers would not have
executed — but relying on CSP to catch injected markup is defence *after* the
mistake, not instead of it, and markup injection alone supports convincing
in-app phishing.

**Fixed.** All three escape now, through one shared, unit-tested `escapeHtml` in
`src/ui/controls.ts` — replacing two divergent private copies, one of which did
not escape quotes at all and so was unsafe in an attribute. Regression tests:
`tests/unit/escaping.test.ts` and an end-to-end test that a hostile fragment
renders as text, creates no element, and defines no global.

### FIXED-2 — Build downloaded executable code without verifying it · *was: High*

`scripts/pyodide-assets.mjs` downloaded the pandas, numpy and matplotlib wheels
from a public CDN at build time and staged them **with no integrity check**,
even though the pinned Pyodide release ships a lock file containing a SHA-256
for every one of them.

This is T4, and it is the most serious structural defect found. Those wheels
become executable code inside every user's browser. A compromised CDN, a
tampered build machine, or a poisoned local cache would have put arbitrary code
into the shipped product, and nothing in the pipeline would have noticed.

**Fixed.** Every wheel is now verified against the lock file's SHA-256 —
including files already on disk, so a cache poisoned between builds is caught.
A mismatch deletes the file and **fails the build**; a wheel with no recorded
digest is refused rather than trusted. The rejection path was tested by
tampering with a staged wheel and confirming the build stopped:

```
REJECTED SHA-256 mismatch for six-1.17.0-py2.py3-none-any.whl — expected
c6681057…, got bba491cb…. File deleted, not staged.
Build stopped: one or more Pyodide wheels failed integrity verification.
```

A wheel that is merely *unreachable* still degrades gracefully to the pure-Python
path, as before — unavailable and untrustworthy are different things.

### FIXED-3 — CI job had no declared permissions · *was: Low*

`test.yml` declared no `permissions:` block, so its token defaulted to whatever
the repository default is. A compromised dependency or action running in that
job could have used it to write to the repository. Now `contents: read`.
(`deploy.yml` was already correctly scoped.)

### FIXED-4 — Offline launcher sent no security headers · *was: Low*

Some protections can only be set as HTTP headers, and the app's CSP is a `<meta>`
tag. Most importantly `frame-ancestors` **cannot** be expressed in a meta tag, so
nothing prevented the page being framed — clickjacking a user's click onto a
control that clears or exports their data.

**Fixed** in both `packaging/serve.py` and `packaging/serve.mjs`, verified live:
`Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a
`Permissions-Policy` denying camera, microphone, geolocation, USB, serial,
Bluetooth and payment. This makes the **offline copy the most hardened way to
run the product** — which is convenient, because it is the one to sanction.

### OPEN-1 — `xlsx` carries two published advisories · **High** · *blocks approval*

`xlsx@0.18.5`: GHSA-4r6h-8v6p-xvw6 (prototype pollution) and GHSA-5pgg-2g8v-p4x9
(ReDoS). `npm audit` reports "no fix available" — misleading: the fix exists, but
SheetJS stopped publishing to npm, so the registry copy is frozen at the last
vulnerable version.

Triggered by T1, which for an audit firm is the *normal* case, not an exotic one.
Bounded by the architecture: no exfiltration is possible whatever the parser
does, parsing is off the main thread, and neither issue reaches native code or
the disk. The realistic consequence is therefore **a silently wrong conversion**
— which, for audit work, is precisely the consequence that matters most.

**Action:** `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, then
rebuild and re-run the suite. Not done here: this environment's network policy
blocks `cdn.sheetjs.com`. Must be run on a machine with access to that host.

### OPEN-2 — GitHub Actions are pinned to mutable tags · **Medium**

Every workflow step uses `actions/checkout@v4`-style tags. A tag can be moved. If
one of those actions were compromised, the attacker would be running inside the
deploy job, which holds `pages: write` and `id-token: write` — i.e. they could
publish a modified application to the URL your firm trusts. T4 again.

**Action:** pin every action to a full commit SHA (`actions/checkout@<sha> # v4`).
Fifteen minutes; enable Dependabot to keep them current.

### OPEN-3 — Opening a foreign notebook does not warn before running · **Medium**

A `.ipynb` is code. Opening one is safe — nothing auto-runs — but **Run all** is
one click away, and a colleague-forwarded notebook is exactly how T2 arrives. The
blast radius is bounded (no network, no disk, in-memory FS), but Python in the
worker can reach the worker's JS scope, so a hostile notebook could at minimum
fabricate convincing but wrong results.

**Action:** when a notebook is opened from a file, show a one-line banner —
*"This notebook came from a file and contains N code steps. Read them before
running."* — and require one dismissal before Run all. Cheap, and it converts an
invisible risk into an informed choice.

### OPEN-4 — Service worker caches opaque responses · **Low**

`vite.config.ts` runtime caching allows `statuses: [0, 200]`. Status 0 is an
opaque cross-origin response. Same-origin policy plus `connect-src 'self'` make
this hard to reach, but there is no reason to permit it.

**Action:** change to `statuses: [200]`. Two minutes.

### OPEN-5 — No Trusted Types · **Low**

About twenty `innerHTML` assignments remain. All currently take literal templates
or escaped values — FIXED-1 dealt with the exceptions — but nothing *structurally*
prevents the next one from being unsafe.

**Action:** adopt `require-trusted-types-for 'script'` with a single vetted
policy, which makes unescaped assignment throw rather than execute. Half a day;
converts a discipline into an enforced rule.

### OPEN-6 — Exports carry no provenance · **Medium (audit-specific)**

A downloaded CSV/XLSX has nothing identifying which tool version produced it, from
which source, when. Not a vulnerability; a *reperformance* gap, and reviewers ask.

**Action:** stamp exports with tool version, timestamp and source file name — an
extra sheet in workbook exports, a header comment in CSV.

### OPEN-7 — Numerical correctness is untested against Excel · **Medium**

The 106 unit tests prove the code does what it was written to do. They do not
prove ExcelTools and Excel agree on an Indian date, a lakh-separated figure, or a
DuckDB type coercion. For a tool feeding workpapers this is the largest
*practical* risk on this page — larger than several items rated higher above,
because it fails silently and looks like a correct answer.

**Action:** a golden-dataset test — a fixed set of nasty real-world files with
independently agreed expected outputs, run in CI.

### OPEN-8 — Single maintainer · **Medium (organisational)**

One person can build, fix and release this. Not a code risk; a continuity one,
and the reviewing partner will raise it. Action: a second person able to build
and release, and a pinned version per engagement.

---

## 4. The plan

Sequenced by risk-reduction per hour, not by how interesting the work is.

### Phase 0 — done in this pass
FIXED-1 through FIXED-4 above. No further action.

### Phase 1 — before anyone else uses it *(about a day)*

| Step | Item | Why first |
|---|---|---|
| 1.1 | Close **OPEN-1** (upgrade `xlsx`) | The only High left; needs a machine that can reach the vendor CDN |
| 1.2 | Pin actions to SHAs (**OPEN-2**) | Protects the channel that reaches every PC |
| 1.3 | `statuses: [200]` (**OPEN-4**) | Two minutes |
| 1.4 | Foreign-notebook banner (**OPEN-3**) | Converts a hidden risk into an informed click |

**Exit criteria:** `npm audit --omit=dev` clean; every action SHA-pinned; the full
suite green.

### Phase 2 — before output supports a workpaper *(about a week)*

| Step | Item |
|---|---|
| 2.1 | Golden-dataset correctness tests in CI (**OPEN-7**) |
| 2.2 | Provenance stamp on exports (**OPEN-6**) |
| 2.3 | Version-pin per engagement; record the commit in the workpaper |

**Exit criteria:** a documented validation file a reviewer can inspect, and any
export traceable to the exact version that produced it.

### Phase 3 — before firm-wide rollout *(ongoing)*

| Step | Item |
|---|---|
| 3.1 | Second maintainer (**OPEN-8**) |
| 3.2 | Trusted Types (**OPEN-5**) |
| 3.3 | Sanction the **offline zip** as the approved channel; treat the hosted URL as convenience only |
| 3.4 | Re-run this audit at each release; keep the version stamp in `SECURITY-APPROVAL.md` current |

### Deliberately not doing

Stated so nobody later assumes it was forgotten:

- **Auditing the browser, Windows, or the user's extensions.** Out of scope, and
  no web app can do it.
- **Encrypting the local draft.** The key would have to live beside it. Browser
  storage is already origin-isolated; the honest control is the off switch that
  already exists.
- **Removing `'unsafe-eval'`.** Pyodide requires it. It permits running code the
  page already has; it does not permit fetching code, which `script-src 'self'`
  and `connect-src 'self'` both forbid.
- **A vulnerability-scanner clean bill as the goal.** Scanners flag `'unsafe-eval'`
  and will keep flagging it. The defensible answer is the written rationale in
  `SECURITY.md`, not contorting the product to please a tool.

---

## 5. How to re-check this yourself

For the IT administrator, in order, each independent of the others:

```
npm ci && npm audit --omit=dev       # expect clean once OPEN-1 is closed
npm run build                        # fails loudly if any wheel fails its digest
npm test && npm run test:e2e         # includes the no-exfiltration guard
```

Then the observational checks in
[`SECURITY-APPROVAL.md`](SECURITY-APPROVAL.md) §B — unzip and confirm nothing
installs, disconnect the network and confirm it still works, watch the Network
tab during real use.

---

**Audit date:** 25 July 2026 · **Fixed in this pass:** 4 · **Open:** 8
(1 High, 5 Medium, 2 Low) · **Blocking approval:** OPEN-1.

This document is the working record. `SECURITY-APPROVAL.md` is the version for
the partner and the IT administrator; `SECURITY.md` is the technical attestation.
