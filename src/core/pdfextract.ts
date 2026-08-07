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

type PdfJs = typeof import('pdfjs-dist');
let lib: PdfJs | null = null;

/** Load pdf.js and point it at the bundled worker. The `new URL(...,
 *  import.meta.url)` form is what lets the bundler emit the worker as a
 *  same-origin asset — a CDN workerSrc would be blocked by the CSP, which is
 *  the intended behaviour. */
async function getLib(): Promise<PdfJs> {
  if (lib) return lib;
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
