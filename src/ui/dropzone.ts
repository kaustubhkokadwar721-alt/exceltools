// Reusable drag-and-drop + click-to-pick file zone. Validates each file and
// reports results back through callbacks; it does not parse anything itself.
import { pickFiles } from '../core/fileio';
import { validateFile, SUPPORTED_EXTENSIONS } from '../core/validation';

export interface DropzoneOptions {
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
}

export function createDropzone(opts: DropzoneOptions): HTMLElement {
  const accept = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');
  const el = document.createElement('div');
  el.className = 'dropzone';
  el.innerHTML = `
    <div class="dropzone-inner">
      <div class="dropzone-icon">⬇</div>
      <div class="dropzone-title">Drop ${opts.multiple ? 'files' : 'a file'} here</div>
      <div class="dropzone-sub">or click to browse — ${SUPPORTED_EXTENSIONS.join(', ')}</div>
      <div class="dropzone-privacy">Files are processed on your machine. Nothing is uploaded.</div>
    </div>`;

  const handle = (files: File[]) => {
    if (!files.length) return;
    const accepted: File[] = [];
    for (const f of files) {
      const v = validateFile(f);
      if (!v.ok) {
        opts.onError(v.error!);
        continue;
      }
      if (v.warning) opts.onWarning?.(v.warning);
      accepted.push(f);
    }
    if (accepted.length) opts.onFiles(opts.multiple ? accepted : accepted.slice(0, 1));
  };

  el.addEventListener('click', async () => handle(await pickFiles(accept, opts.multiple)));

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('dragover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    if (e.dataTransfer?.files) handle(Array.from(e.dataTransfer.files));
  });

  return el;
}
