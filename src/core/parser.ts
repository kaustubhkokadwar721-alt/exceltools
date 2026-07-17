// Public parse/serialize API used by tools. Wraps the worker harness so tools
// never touch message plumbing — they just await a workbook or a blob.
import { WorkerHarness } from './worker-harness';
import type { Workbook, SheetData, ExportFormat } from './types';

// One shared worker for the whole app. Parsing is serialized through it, which
// is fine — the point is keeping the *main thread* free, not parallelism.
let harness: WorkerHarness | null = null;
function getHarness(): WorkerHarness {
  if (!harness) harness = new WorkerHarness();
  return harness;
}

/**
 * Parse a spreadsheet file into a Workbook, off the main thread.
 * @param previewRows optional cap on data rows per sheet (for fast previews).
 */
export async function parseFile(file: File, previewRows?: number): Promise<Workbook> {
  const buffer = await file.arrayBuffer();
  const res = await getHarness().send<Extract<import('./types').WorkerResponse, { ok: true; kind: 'parse' }>>(
    { kind: 'parse', buffer, fileName: file.name, fileSize: file.size, previewRows },
    [buffer], // transfer ownership — no copy
  );
  return res.workbook;
}

/** Serialize one sheet to the given format, returning a downloadable blob. */
export async function serializeSheet(
  sheet: SheetData,
  format: ExportFormat,
): Promise<{ blob: Blob; ext: string }> {
  const res = await getHarness().send<Extract<import('./types').WorkerResponse, { ok: true; kind: 'serialize' }>>(
    { kind: 'serialize', sheet, format },
  );
  return { blob: res.blob, ext: res.ext };
}

export type { Workbook, SheetData, ExportFormat };
