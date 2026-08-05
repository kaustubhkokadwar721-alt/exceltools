// Reusable drag-and-drop + click-to-pick file zone. Validates each file and
// reports results back through callbacks; it does not parse anything itself.
import { pickFiles } from '../core/fileio';
import { validateFile, SUPPORTED_EXTENSIONS } from '../core/validation';
import { icon } from './icons';

export interface DropzoneOptions {
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
}

/**
 * A single top row rather than a large empty box: the action sits on the left
 * where reading starts, and the promise that matters to the user — that the file
 * never leaves the machine — is stated on the right, large enough to be read
 * rather than skipped. The whole row is still the drop target.
 */
export function createDropzone(opts: DropzoneOptions): HTMLElement {
  const accept = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');
  const label = `Add ${opts.multiple ? 'files' : 'a file'}`;
  const el = document.createElement('div');
  el.className = 'dropzone';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${label} — drop here or choose from this device`);
  el.innerHTML = `
    <span class="dropzone-action">
      <span class="dropzone-icon" aria-hidden="true">${icon('upload')}</span>
      <span class="dropzone-text">
        <span class="dropzone-title">${label}</span>
        <span class="dropzone-sub">Drop here, or click to choose</span>
      </span>
    </span>
    <span class="dropzone-privacy">Files stay on this device. Nothing is uploaded to cloud.</span>`;

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
  el.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handle(await pickFiles(accept, opts.multiple));
    }
  });

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
