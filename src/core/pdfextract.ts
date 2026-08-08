// The pdf.js side of PDF import: a file in, positioned text runs out.
//
// Deliberately thin. Everything that decides what a *table* is lives in
// pdftable.ts, which imports nothing from here and so can be tested without a
// PDF. This module only speaks pdf.js.
//
// pdf.js is configured to do nothing but read text: no font faces, no system
// fonts, and no fetching of any kind. Combined with `connect-src 'self'` that
// makes PDF import as offline as the rest of the suite — the worker is bundled
// and served same-origin, never from a CDN.
import type { PdfPage, TextRun } from './pdftable';

/** Raised when the file is encrypted. Indian bank statements routinely are —
 *  the tool asks for the password rather than reporting an unreadable file. */
export class PdfPasswordRequired extends Error {
  constructor(public readonly wrongPassword: boolean) {
    super(wrongPassword ? 'That password did not open the file.' : 'This PDF is password-protected.');
    this.name = 'PdfPasswordRequired';
  }
}

/** Raised when the browser is too old to run the bundled pdf.js at all. */
export class PdfUnsupportedBrowser extends Error {
  constructor(public readonly missing: string[]) {
    super(
      'This browser is too old to read PDFs. Chrome or Edge 119+, Firefox 121+, ' +
        'or Safari 17.4+ can; every other tool in the suite works as it is.',
    );
    this.name = 'PdfUnsupportedBrowser';
  }
}

/**
 * Builtins the pinned pdf.js build calls but does not polyfill itself.
 *
 * This is checked up front because of *how* pdf.js fails without them: the call
 * sites are inside its worker plumbing, where the TypeError escapes as an
 * unhandled rejection instead of rejecting the promise `readPdf` awaits. The
 * read then never settles — no error, no result, and the caller is left waiting
 * forever on a file that can never load. A cheap check here turns that into a
 * sentence the person reading it can act on.
 *
 * Tied to the `pdfjs-dist` pin in package.json: a major bump can add to what
 * pdf.js assumes, which is exactly how this list goes stale. The floor is
 * pinned from the other side too — see the browser-floor cases in
 * tests/e2e/pdf.spec.ts, which fail if a bump reintroduces a newer-only API.
 *
 * Probed untyped on purpose: `lib` is ES2022, so naming `Promise.withResolvers`
 * as a typed property would not compile — and raising `lib` to reach it would
 * hand the rest of the codebase the same newer-than-the-floor APIs that caused
 * this. The cast stays local to the probe.
 */
const REQUIRED: [name: string, present: () => boolean][] = [
  ['Promise.withResolvers', () => typeof (Promise as { withResolvers?: unknown }).withResolvers === 'function'],
  ['structuredClone', () => typeof structuredClone === 'function'],
];

type PdfJs = typeof import('pdfjs-dist');
let lib: PdfJs | null = null;

/** Load pdf.js and point it at the bundled worker. The `new URL(...,
 *  import.meta.url)` form is what lets the bundler emit the worker as a
 *  same-origin asset — a CDN workerSrc would be blocked by the CSP, which is
 *  the intended behaviour. */
async function getLib(): Promise<PdfJs> {
  if (lib) return lib;
  const missing = REQUIRED.filter(([, present]) => !present()).map(([name]) => name);
  if (missing.length) {
    // The sentence shown on screen names browser versions, not JS builtins. The
    // builtins go here instead, so an administrator asked "why not on this PC?"
    // has the specific answer without it being in an accountant's way.
    console.warn(`PDF reading unavailable — this browser lacks: ${missing.join(', ')}`);
    throw new PdfUnsupportedBrowser(missing);
  }
  const mod = await import('pdfjs-dist');
  mod.GlobalWorkerOptions.workerPort = new Worker(
    new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
    { type: 'module' },
  );
  lib = mod;
  return lib;
}

export interface ReadOptions {
  password?: string;
  /** Called after each page so a long document can show progress. */
  onProgress?: (done: number, total: number) => void;
  /** Checked between pages; returning true abandons the read. */
  cancelled?: () => boolean;
}

/**
 * Read every page's text layer.
 *
 * Coordinates come back measured downward from the top of the page, via the
 * viewport transform rather than a manual flip, so a page with a /Rotate entry
 * lands the right way up.
 */
export async function readPdf(file: File, opts: ReadOptions = {}): Promise<PdfPage[]> {
  const pdfjs = await getLib();
  const data = new Uint8Array(await file.arrayBuffer());

  const task = pdfjs.getDocument({
    data,
    password: opts.password,
    disableFontFace: true, // nothing is rendered, so no @font-face needed
    useSystemFonts: false,
    useWorkerFetch: false, // never let the worker reach the network
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === 'PasswordException') {
      // code 1 = a password is needed, 2 = the one supplied was wrong.
      throw new PdfPasswordRequired(err.code === 2);
    }
    throw e;
  }

  try {
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (opts.cancelled?.()) break;
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str === '') continue;
        // Map the run's own matrix through the viewport so the result is in
        // top-down page space regardless of page rotation.
        const t = pdfjs.Util.transform(viewport.transform, item.transform);
        const h = Math.hypot(t[2], t[3]) || item.height || 10;
        runs.push({ text: item.str, x: t[4], y: t[5], w: item.width, h });
      }
      pages.push({ page: n, runs });
      page.cleanup();
      opts.onProgress?.(n, doc.numPages);
    }
    return pages;
  } finally {
    // Destroying the loading task tears down the document and the worker's
    // copy of the file, so a closed PDF leaves nothing resident.
    await task.destroy();
  }
}
