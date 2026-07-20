// Python engine worker (Pyodide). Loads core from self-hosted /pyodide/ assets,
// tries to enable pandas (wheels are staged in CI builds; absent wheels just
// disable the pandas path), exposes registered tables to Python, runs user code
// and returns `result` as a grid. All local — nothing leaves the device.
import type { CellValue } from '../core/types';

interface InitMsg { kind: 'init'; indexURL: string }
interface RegisterMsg { kind: 'register'; name: string; headers: string[]; rows: CellValue[][] }
interface RunMsg { kind: 'run'; id: number; code: string }
type InMsg = InitMsg | RegisterMsg | RunMsg;

// Pyodide's types aren't loaded here (runtime import); keep it minimal.
interface Pyodide {
  runPython(code: string): unknown;
  loadPackage(names: string[]): Promise<unknown>;
  globals: { set(name: string, value: unknown): void };
  toPy(value: unknown): unknown;
}

let py: Pyodide | null = null;
let pandasReady = false;

const HELPERS = `
import json

def _xt_to_table(r):
    try:
        import pandas as pd
        if isinstance(r, pd.Series):
            r = r.reset_index()
        if isinstance(r, pd.DataFrame):
            d = r.reset_index() if not r.index.equals(pd.RangeIndex(len(r))) else r
            rows = d.astype(object).where(d.notna(), None).values.tolist()
            return {"headers": [str(c) for c in d.columns], "rows": rows}
    except ImportError:
        pass
    if isinstance(r, dict):
        return {"headers": [str(k) for k in r.keys()], "rows": [list(r.values())]}
    if isinstance(r, (list, tuple)):
        r = list(r)
        if r and isinstance(r[0], dict):
            hs = list(r[0].keys())
            return {"headers": [str(h) for h in hs], "rows": [[x.get(h) for h in hs] for x in r]}
        return {"headers": ["value"], "rows": [[x] for x in r]}
    return {"headers": ["value"], "rows": [[r]]}
`;

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.kind === 'init') {
      const mod = await import(/* @vite-ignore */ msg.indexURL + 'pyodide.mjs');
      py = (await mod.loadPyodide({ indexURL: msg.indexURL })) as Pyodide;
      try {
        await py.loadPackage(['pandas']);
        py.runPython('import pandas');
        pandasReady = true;
      } catch {
        pandasReady = false; // wheels not staged in this build — pure Python only
      }
      py.runPython(HELPERS);
      py.runPython('tables = {}');
      self.postMessage({ kind: 'ready', pandas: pandasReady });
    } else if (msg.kind === 'register') {
      if (!py) throw new Error('engine not initialised');
      const records = msg.rows.map((r) => {
        const o: Record<string, CellValue> = {};
        msg.headers.forEach((h, i) => (o[h] = r[i] ?? null));
        return o;
      });
      py.globals.set('_xt_rows', py.toPy(records));
      py.globals.set('_xt_name', msg.name);
      py.runPython('tables[_xt_name] = list(_xt_rows)');
      if (pandasReady) {
        py.runPython(`import pandas as pd\nglobals()["df_" + _xt_name] = pd.DataFrame(tables[_xt_name])`);
      }
      self.postMessage({ kind: 'registered', name: msg.name });
    } else if (msg.kind === 'run') {
      if (!py) throw new Error('engine not initialised');
      py.globals.set('_xt_code', msg.code);
      const started = performance.now();
      const out = py.runPython(`
_g = globals()
exec(_xt_code, _g)
json.dumps(_xt_to_table(_g.get("result")))
`) as string;
      const table = JSON.parse(out) as { headers: string[]; rows: CellValue[][] };
      self.postMessage({ kind: 'result', id: msg.id, ok: true, table, elapsedMs: performance.now() - started });
    }
  } catch (e) {
    const base = { ok: false, error: e instanceof Error ? e.message : String(e) };
    if (msg.kind === 'run') self.postMessage({ kind: 'result', id: msg.id, ...base });
    else self.postMessage({ kind: 'error', ...base });
  }
};
