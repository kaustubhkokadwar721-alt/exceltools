// Python notebook worker (Pyodide). Loads core from self-hosted /pyodide/,
// enables pandas + matplotlib when their wheels are staged (CI builds; offline
// builds degrade gracefully), and runs notebook cells with Jupyter semantics:
// captured stdout/stderr, last-expression display, DataFrame → grid, matplotlib
// figures → PNG images. Globals persist across cells. All local.
import type { CellValue } from '../core/types';

interface InitMsg { kind: 'init'; indexURL: string }
interface RegisterMsg { kind: 'register'; name: string; headers: string[]; rows: CellValue[][] }
interface RunCellMsg { kind: 'runCell'; id: number; code: string }
interface VarsMsg { kind: 'vars' }
type InMsg = InitMsg | RegisterMsg | RunCellMsg | VarsMsg;

export type CellOut =
  | { type: 'table'; headers: string[]; rows: CellValue[][] }
  | { type: 'image'; png: string }
  | { type: 'text'; text: string };

interface Pyodide {
  runPython(code: string): unknown;
  loadPackage(names: string[]): Promise<unknown>;
  globals: { set(name: string, value: unknown): void };
  toPy(value: unknown): unknown;
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
}

let py: Pyodide | null = null;
let pandasReady = false;
let chartsReady = false;
let stdoutBuf: string[] = [];

// One Python runtime helper module: cell execution with Jupyter semantics and
// output collection. Returns a JSON payload per cell.
const RUNTIME = `
import ast, json, traceback

_g = globals()
tables = {}

def _xt_cell(v):
    """JSON-safe scalar. NaN/Infinity are not valid JSON, so they read as blank."""
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    return repr(v)

def _xt_to_table(r):
    try:
        import pandas as pd
        if isinstance(r, pd.Series):
            r = r.reset_index()
        if isinstance(r, pd.DataFrame):
            d = r.reset_index() if not r.index.equals(pd.RangeIndex(len(r))) else r
            rows = d.astype(object).where(d.notna(), None).values.tolist()
            return {"type": "table", "headers": [str(c) for c in d.columns], "rows": rows}
    except ImportError:
        pass
    # Plain Python shapes that are really tables. Without this, a result like
    # [{"Dept": "Fin", "Total": 1650}, ...] prints as one long line of repr —
    # unreadable, and impossible to export to a spreadsheet.
    if isinstance(r, (list, tuple)) and r:
        if all(isinstance(x, dict) for x in r):
            headers = []
            for x in r:
                for k in x.keys():
                    if k not in headers:
                        headers.append(k)
            return {
                "type": "table",
                "headers": [str(h) for h in headers],
                "rows": [[_xt_cell(x.get(h)) for h in headers] for x in r],
            }
        if all(isinstance(x, (list, tuple)) for x in r) and len(set(len(x) for x in r)) == 1:
            return {
                "type": "table",
                "headers": ["Column %d" % (i + 1) for i in range(len(r[0]))],
                "rows": [[_xt_cell(v) for v in x] for x in r],
            }
        if len(r) > 10 and all(not isinstance(x, (list, tuple, dict, set)) for x in r):
            return {"type": "table", "headers": ["Value"], "rows": [[_xt_cell(v)] for v in r]}
    if isinstance(r, dict) and r and all(not isinstance(v, (list, tuple, dict, set)) for v in r.values()):
        return {"type": "table", "headers": ["Key", "Value"], "rows": [[str(k), _xt_cell(v)] for k, v in r.items()]}
    return None

def _xt_figures():
    out = []
    try:
        import matplotlib.pyplot as plt
        import io, base64
        for num in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
            out.append({"type": "image", "png": base64.b64encode(buf.getvalue()).decode()})
        plt.close("all")
    except ImportError:
        pass
    return out

def _xt_run_cell(code):
    outputs = []
    try:
        tree = ast.parse(code)
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body[-1].value)
            tree.body = tree.body[:-1]
        exec(compile(tree, "<cell>", "exec"), _g)
        value = eval(compile(last, "<cell>", "eval"), _g) if last is not None else None
        outputs.extend(_xt_figures())
        if value is not None:
            t = _xt_to_table(value)
            if t is not None:
                outputs.append(t)
            else:
                outputs.append({"type": "text", "text": repr(value)})
        return json.dumps({"ok": True, "outputs": outputs})
    except BaseException as exc:
        tb = traceback.format_exc()
        # Trim runner frames: keep from the <cell> frame onward when present.
        lines = tb.splitlines()
        idx = next((i for i, l in enumerate(lines) if '"<cell>"' in l or "<cell>" in l), 1)
        trimmed = "\\n".join([lines[0]] + lines[idx:])
        return json.dumps({
            "ok": False,
            "error": trimmed,
            "etype": type(exc).__name__,
            "evalue": str(exc),
            "outputs": _xt_figures(),
        })

def _xt_vars():
    """Everything the user created, for the variable inspector."""
    try:
        import pandas as pd
    except ImportError:
        pd = None
    out = []
    for k, v in list(_g.items()):
        if k.startswith("_") or k == "tables":
            continue
        if callable(v) or type(v).__name__ == "module":
            continue
        if pd is not None and isinstance(v, pd.DataFrame):
            out.append({
                "name": k,
                "type": "table",
                "detail": "{:,} rows x {} columns".format(len(v), len(v.columns)),
                "columns": [str(c) for c in v.columns][:80],
            })
            continue
        if pd is not None and isinstance(v, pd.Series):
            out.append({"name": k, "type": "column", "detail": "{:,} values".format(len(v))})
            continue
        t = type(v).__name__
        try:
            detail = "{:,} items".format(len(v)) if t in ("list", "dict", "tuple", "set") else repr(v)
        except Exception:
            detail = t
        out.append({"name": k, "type": t, "detail": detail[:120]})
    return json.dumps(sorted(out, key=lambda d: d["name"]))
`;

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.kind === 'init') {
      const mod = await import(/* @vite-ignore */ msg.indexURL + 'pyodide.mjs');
      py = (await mod.loadPyodide({ indexURL: msg.indexURL })) as Pyodide;
      py.setStdout({ batched: (s) => stdoutBuf.push(s) });
      py.setStderr({ batched: (s) => stdoutBuf.push(s) });
      try {
        await py.loadPackage(['pandas']);
        py.runPython('import pandas');
        pandasReady = true;
      } catch { pandasReady = false; }
      try {
        await py.loadPackage(['matplotlib']);
        py.runPython('import matplotlib; matplotlib.use("Agg")');
        chartsReady = true;
      } catch { chartsReady = false; }
      py.runPython(RUNTIME);
      self.postMessage({ kind: 'ready', pandas: pandasReady, charts: chartsReady });
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
        py.runPython('import pandas as pd\n_g["df_" + _xt_name] = pd.DataFrame(tables[_xt_name])');
      }
      self.postMessage({ kind: 'registered', name: msg.name });
    } else if (msg.kind === 'runCell') {
      if (!py) throw new Error('engine not initialised');
      stdoutBuf = [];
      py.globals.set('_xt_code', msg.code);
      const started = performance.now();
      const raw = py.runPython('_xt_run_cell(_xt_code)') as string;
      const parsed = JSON.parse(raw) as { ok: boolean; outputs: CellOut[]; error?: string; etype?: string };
      self.postMessage({
        kind: 'cellResult',
        id: msg.id,
        ok: parsed.ok,
        // Batched chunks already carry their newlines — joining adds blank lines.
        stdout: stdoutBuf.join(''),
        outputs: parsed.outputs,
        error: parsed.error,
        etype: parsed.etype,
        elapsedMs: performance.now() - started,
      });
    } else if (msg.kind === 'vars') {
      if (!py) throw new Error('engine not initialised');
      self.postMessage({ kind: 'vars', vars: JSON.parse(py.runPython('_xt_vars()') as string) });
    }
  } catch (e) {
    const base = { ok: false, error: e instanceof Error ? e.message : String(e) };
    if (msg.kind === 'runCell') {
      self.postMessage({ kind: 'cellResult', id: msg.id, stdout: stdoutBuf.join(''), outputs: [], ...base });
    } else if (msg.kind === 'vars') {
      self.postMessage({ kind: 'vars', vars: [] });
    } else {
      self.postMessage({ kind: 'error', ...base });
    }
  }
};
