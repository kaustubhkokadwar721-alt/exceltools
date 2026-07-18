// File I/O helpers: getting bytes in (picker/drag-drop) and out (download).
// Kept UI-agnostic; the dropzone component wires these to DOM events.

/** Trigger a local "Save as" download of a blob. Never touches the network. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Swap a file's extension, preserving the base name. */
export function withExtension(fileName: string, ext: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot === -1 ? fileName : fileName.slice(0, dot);
  return `${base}.${ext}`;
}

/** Open a native file picker and resolve with the chosen files (or []). */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(input.files ? Array.from(input.files) : []));
    // If the user cancels, 'change' never fires; that's acceptable (no resolve).
    input.click();
  });
}
