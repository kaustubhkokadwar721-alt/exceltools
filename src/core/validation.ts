// Centralised file validation + human-friendly error messages, so every tool
// rejects bad input the same way instead of each re-implementing checks.

export const SUPPORTED_EXTENSIONS = ['xlsx', 'xls', 'xlsm', 'xltx', 'csv', 'tsv', 'ods'] as const;

// Soft ceiling: above this the light (SheetJS) path gets slow/memory-heavy.
// Tier-2 (DuckDB) will raise this later. We warn rather than hard-block.
// Limits set from measured behaviour (see docs/PERFORMANCE.md): SheetJS parse is
// the bottleneck — ~9s at 31 MB / 200k rows, and a browser tab can OOM well below
// the old 250 MB cap (a ~78 MB / 500k-row file crashed it). Warn early, block
// before the danger zone.
export const SOFT_SIZE_WARN_BYTES = 25 * 1024 * 1024; // 25 MB — parse gets slow
export const HARD_SIZE_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB — OOM risk beyond

export interface ValidationResult {
  ok: boolean;
  error?: string;
  warning?: string;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function validateFile(file: File): ValidationResult {
  const ext = extensionOf(file.name);

  if (!ext) {
    return { ok: false, error: `"${file.name}" has no file extension. Expected one of: ${SUPPORTED_EXTENSIONS.join(', ')}.` };
  }
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `Unsupported file type ".${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.` };
  }
  if (file.size === 0) {
    return { ok: false, error: `"${file.name}" is empty (0 bytes).` };
  }
  if (file.size > HARD_SIZE_LIMIT_BYTES) {
    return { ok: false, error: `"${file.name}" is ${formatBytes(file.size)}, above the ${formatBytes(HARD_SIZE_LIMIT_BYTES)} limit for in-browser processing.` };
  }
  if (file.size > SOFT_SIZE_WARN_BYTES) {
    return { ok: true, warning: `"${file.name}" is ${formatBytes(file.size)}. Large files may be slow in the light engine; processing runs off the main thread so the UI stays responsive.` };
  }
  return { ok: true };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
