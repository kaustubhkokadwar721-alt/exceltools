// Worker harness: owns the single parser worker and turns its message-passing
// into clean promises. One instance is shared app-wide (see parser.ts).
import ParserWorker from '../workers/parser.worker?worker';
import type { WorkerRequest, WorkerResponse } from './types';

// Omit that distributes over a union, so each request variant keeps its own
// fields (a plain Omit<Union, 'id'> collapses to only the shared keys).
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

type Pending = {
  resolve: (res: Extract<WorkerResponse, { ok: true }>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Ceiling on one request. The worker answers a 100 MB file (the hard limit in
 * validation.ts) well inside this; anything longer means it is not coming back.
 * Without a ceiling a dead worker shows as a spinner that never resolves, and
 * the only cure is a page reload the user has no reason to try.
 */
const REQUEST_TIMEOUT_MS = 180_000;

export class WorkerHarness {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new ParserWorker();
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    // A worker that dies takes every in-flight request with it. Parsing a file
    // near the size limit can exhaust the tab (see docs/PERFORMANCE.md), so this
    // path is reachable in normal use — reject what was waiting, then replace the
    // worker so the next attempt is not posting into a corpse.
    w.onerror = (ev) => this.recover(new Error(ev.message || 'The file reader stopped unexpectedly.'));
    w.onmessageerror = () => this.recover(new Error('The file reader sent a message that could not be read.'));
    return w;
  }

  /** Send a request (minus its id) and await the matching typed response. */
  send<R extends Extract<WorkerResponse, { ok: true }>>(
    req: DistributiveOmit<WorkerRequest, 'id'>,
    transfer?: Transferable[],
  ): Promise<R> {
    const id = this.nextId++;
    const full = { ...req, id } as WorkerRequest;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Reading the file took too long and was stopped. It may be too large for this browser.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer });
      try {
        this.worker.postMessage(full, transfer ?? []);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handle(res: WorkerResponse) {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res);
    else p.reject(new Error(res.error));
  }

  private recover(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.worker.terminate();
    this.worker = this.spawn();
  }
}
