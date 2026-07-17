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
};

export class WorkerHarness {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new ParserWorker();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    this.worker.onerror = (ev) => this.failAll(new Error(ev.message || 'Worker crashed'));
  }

  /** Send a request (minus its id) and await the matching typed response. */
  send<R extends Extract<WorkerResponse, { ok: true }>>(
    req: DistributiveOmit<WorkerRequest, 'id'>,
    transfer?: Transferable[],
  ): Promise<R> {
    const id = this.nextId++;
    const full = { ...req, id } as WorkerRequest;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.worker.postMessage(full, transfer ?? []);
    });
  }

  private handle(res: WorkerResponse) {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res);
    else p.reject(new Error(res.error));
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
