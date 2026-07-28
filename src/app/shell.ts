// App shell: a fixed-height frame that never scrolls. A slim app bar carries
// identity, the tool switcher, the privacy badge and status; below it sit an
// optional data panel and one working surface. Everything that scrolls scrolls
// inside itself, so a tool's first control is always on screen.
import { TOOLS, findTool, type ToolDef } from './registry';
import { onRouteChange, navigate, type Route } from './router';
import { escapeHtml } from '../ui/controls';
import { toast } from '../ui/toast';
import { iconTool } from '../ui/icons';

type StatusState = 'success' | 'busy' | 'error';
let statusEl: HTMLElement | null = null;
let shellRoot: HTMLElement | null = null;
let currentToolId: string | null = null;
/** Set by whichever tool owns the panel; cleared when the panel closes. */
let panelDrop: ((files: File[]) => void) | null = null;

const PANEL_COLLAPSED_KEY = 'exceltools.panel.collapsed';
/* Below this the panel cannot sit beside the work, so it overlays it — and an
   overlay must not be the state you arrive in. */
const NARROW = '(max-width: 820px)';

/** Update the app-bar status line. */
export function setAppStatus(message: string, state: StatusState = 'success'): void {
  if (!statusEl) return;
  const dot = statusEl.querySelector<HTMLElement>('.dot')!;
  const txt = statusEl.querySelector<HTMLElement>('.txt')!;
  dot.style.background = state === 'error' ? 'var(--rgy-red)' : state === 'busy' ? 'var(--rgy-gold)' : 'var(--rgy-green)';
  txt.textContent = state === 'success' ? 'Ready' : message;
  statusEl.classList.toggle('is-busy', state === 'busy');
  statusEl.classList.toggle('is-error', state === 'error');
}

export interface DataPanelOptions {
  /** Panel heading, e.g. "Your data". */
  title: string;
  /** Optional action in the panel header, e.g. "＋ Add files". */
  actionLabel?: string;
  onAction?: () => void;
  /** Accessible name for the panel region. */
  label?: string;
  /** Files dropped anywhere on the panel. Setting this also shows the line that
   *  says dropping is possible — an invisible drop target helps nobody. */
  onDropFiles?: (files: File[]) => void;
}

/**
 * Open the shell's left data panel and return the element to render into.
 * The shell owns the header, the collapse toggle and the privacy footer; the
 * tool owns the body. Calling it again reuses the same body element so a rail
 * can re-render without the panel flickering.
 */
export function openDataPanel(opts: DataPanelOptions): HTMLElement {
  const panel = shellRoot!.querySelector<HTMLElement>('#datapanel')!;
  panel.hidden = false;
  for (const id of ['#paneltoggle', '#panelbtn']) shellRoot!.querySelector<HTMLElement>(id)!.hidden = false;
  panel.setAttribute('aria-label', opts.label ?? opts.title);
  const head = panel.querySelector<HTMLElement>('.panel-title')!;
  head.textContent = opts.title;
  const act = panel.querySelector<HTMLButtonElement>('.panel-action')!;
  act.hidden = !opts.actionLabel;
  if (opts.actionLabel) {
    act.textContent = opts.actionLabel;
    act.onclick = () => opts.onAction?.();
  } else {
    act.onclick = null;
  }

  const hint = panel.querySelector<HTMLElement>('.panel-hintbar')!;
  hint.hidden = !opts.onDropFiles;
  panelDrop = opts.onDropFiles ?? null;

  return panel.querySelector<HTMLElement>('.panel-body')!;
}

/** Hide the data panel — for tools and routes that have no tables to show. */
export function closeDataPanel(): void {
  const panel = shellRoot?.querySelector<HTMLElement>('#datapanel');
  if (!panel) return;
  panel.hidden = true;
  for (const id of ['#paneltoggle', '#panelbtn']) shellRoot!.querySelector<HTMLElement>(id)!.hidden = true;
  panel.querySelector<HTMLElement>('.panel-body')!.innerHTML = '';
  panel.querySelector<HTMLElement>('.panel-hintbar')!.hidden = true;
  panelDrop = null;
}

export function mountShell(root: HTMLElement): void {
  shellRoot = root;
  const collapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1' || matchMedia(NARROW).matches;
  root.innerHTML = `
    <div class="app-shell${collapsed ? ' panel-collapsed' : ''}">
      <header class="app-bar">
        <button class="brand-mark" id="brand" type="button" title="ExcelTools — all tools">Xt</button>
        <div class="switcher">
          <button class="switch-btn" id="switch" type="button" aria-haspopup="menu" aria-expanded="false">
            <span class="switch-label">All tools</span><span class="switch-caret" aria-hidden="true">▾</span>
          </button>
          <div class="switch-menu" id="switchmenu" role="menu" hidden></div>
        </div>
        <span class="app-crumb" id="crumb"></span>
        <div class="app-bar-right">
          <span class="app-status" id="status"><span class="dot"></span><span class="txt">Ready</span></span>
          <a class="privacy-badge" href="#/privacy" title="Your files are read on this computer and nowhere else. Nothing is uploaded.">
            <span class="dot"></span><span class="badge-text">Private · offline</span>
          </a>
          <button class="bar-btn panel-btn" id="panelbtn" type="button" hidden aria-expanded="false">▤</button>
          <button class="bar-btn" id="helpbtn" type="button" aria-haspopup="dialog" aria-expanded="false" title="How this tool works">?</button>
        </div>
        <div class="help-pop" id="helppop" hidden></div>
      </header>
      <div class="app-body">
        <aside class="app-panel" id="datapanel" hidden>
          <div class="panel-head">
            <span class="panel-title"></span>
            <button class="panel-action btn-ghost" type="button" hidden></button>
          </div>
          <div class="panel-hintbar" hidden>or drop files here</div>
          <div class="panel-body"></div>
          <div class="panel-foot"><span class="dot"></span>Nothing leaves this device</div>
          <div class="panel-grip" id="panelgrip" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the data panel"></div>
        </aside>
        <button class="panel-toggle" id="paneltoggle" type="button" hidden></button>
        <main class="app-work" id="content" tabindex="-1"></main>
      </div>
    </div>`;

  statusEl = root.querySelector<HTMLElement>('#status');
  root.querySelector('#brand')!.addEventListener('click', () => navigate({ name: 'home' }));

  wireSwitcher(root);
  wireHelp(root);
  wirePanelToggle(root);
  wirePanelResize(root);
  wirePanelDrop(root);

  const content = root.querySelector<HTMLElement>('#content')!;
  onRouteChange((route) => renderRoute(content, route));
}

// ---- tool switcher ----------------------------------------------------------

// The nine tools no longer sit permanently on screen, so the switcher has to
// carry their discovery too: it lists every tool with its one-line description,
// grouped the way the home page groups them. One click, and you can read what
// each tool does — which the old nine terse links never told you.
function wireSwitcher(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>('#switch')!;
  const menu = root.querySelector<HTMLElement>('#switchmenu')!;

  const groups: { label: string; cls: string; hint: string; tools: ToolDef[] }[] = [
    {
      label: 'Quick tools',
      cls: '',
      hint: 'instant, no download',
      tools: TOOLS.filter((t) => t.tier === 'light'),
    },
    {
      label: 'Data analysis tools',
      cls: 'sql',
      hint: 'engine downloads once, then works offline',
      tools: ['query', 'pivot', 'python'].map((id) => findTool(id)!).filter(Boolean),
    },
  ];

  menu.innerHTML = groups
    .map(
      (g) => `
      <div class="switch-group ${g.cls}"><span class="dot"></span><b>${g.label}</b><span>${g.hint}</span></div>
      ${g.tools
        .map(
          (t) => `
        <a class="switch-item" role="menuitem" href="#/tool/${t.id}" data-id="${t.id}">
          <span class="switch-icon">${iconTool(t.id)}</span>
          <span class="switch-text">
            <span class="switch-name">${escapeHtml(t.title)}${t.status === 'planned' ? ' <span class="nav-tag">soon</span>' : ''}</span>
            <span class="switch-blurb">${escapeHtml(t.blurb)}</span>
          </span>
        </a>`,
        )
        .join('')}`,
    )
    .join('');

  const close = (): void => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const target =
      (currentToolId && menu.querySelector<HTMLElement>(`.switch-item[data-id="${currentToolId}"]`)) ||
      menu.querySelector<HTMLElement>('.switch-item');
    // preventScroll: the menu would otherwise jump to the active tool and cut
    // the group heading above it in half.
    target?.focus({ preventScroll: true });
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden ? open() : close();
  });
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.switch-item')) close();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      close();
      btn.focus();
    }
  });
  // role="menu" promises arrow keys; without them the two-column grid is a
  // tab-through list that reads in the wrong order.
  menu.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll<HTMLElement>('.switch-item')];
    const here = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : (here + step + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView({ block: 'nearest' });
  });
}

function setSwitcherLabel(tool: ToolDef | null): void {
  const label = shellRoot?.querySelector<HTMLElement>('.switch-label');
  if (label) label.textContent = tool ? tool.title : 'All tools';
  shellRoot?.querySelectorAll<HTMLElement>('.switch-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === tool?.id);
  });
}

/** Context line in the app bar — a tool's loaded file, sheet, or nothing. */
export function setCrumb(text: string): void {
  const crumb = shellRoot?.querySelector<HTMLElement>('#crumb');
  if (crumb) crumb.textContent = text;
}

// ---- help popover -----------------------------------------------------------

// The steps used to sit in the page as a collapsed panel above the work. They
// are read once and then cost 40px forever, so they moved behind "?".
function wireHelp(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>('#helpbtn')!;
  const pop = root.querySelector<HTMLElement>('#helppop')!;
  const close = (): void => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pop.hidden) return close();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      close();
      btn.focus();
    }
  });
}

function renderHelp(tool: ToolDef | null): void {
  const btn = shellRoot!.querySelector<HTMLButtonElement>('#helpbtn')!;
  const pop = shellRoot!.querySelector<HTMLElement>('#helppop')!;
  pop.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (!tool) {
    btn.hidden = true;
    pop.innerHTML = '';
    return;
  }
  btn.hidden = false;
  const steps = (tool.help ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  const note = tool.helpNote ? `<p class="rgy-help__note">${escapeHtml(tool.helpNote)}</p>` : '';
  pop.innerHTML = `
    <h3>${escapeHtml(tool.title)}</h3>
    <p class="help-blurb">${escapeHtml(tool.blurb)}</p>
    ${steps ? `<ol class="rgy-help__steps">${steps}</ol>` : ''}
    ${note}`;
}

// ---- panel collapse ---------------------------------------------------------

function wirePanelToggle(root: HTMLElement): void {
  const shell = root.querySelector<HTMLElement>('.app-shell')!;
  const seam = root.querySelector<HTMLButtonElement>('#paneltoggle')!;
  // The seam sits between panel and work, which is where you want it on a wide
  // screen and underneath the overlay on a narrow one — hence a bar button too.
  const barBtn = root.querySelector<HTMLButtonElement>('#panelbtn')!;

  const sync = (): void => {
    const off = shell.classList.contains('panel-collapsed');
    seam.textContent = off ? '›' : '‹';
    const label = off ? 'Show your data' : 'Hide the data panel';
    for (const b of [seam, barBtn]) {
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-expanded', String(!off));
    }
  };
  const toggle = (): void => {
    const off = shell.classList.toggle('panel-collapsed');
    localStorage.setItem(PANEL_COLLAPSED_KEY, off ? '1' : '0');
    sync();
  };
  seam.addEventListener('click', toggle);
  barBtn.addEventListener('click', toggle);

  // On a narrow screen the panel covers the work, so anything you do out there
  // is a request to get it out of the way.
  root.querySelector('#content')!.addEventListener('pointerdown', () => {
    if (matchMedia(NARROW).matches && !shell.classList.contains('panel-collapsed')) {
      shell.classList.add('panel-collapsed');
      sync();
    }
  });
  // Widening the window turns the overlay back into a column; a panel the user
  // never asked to hide should come back with it.
  matchMedia(NARROW).addEventListener('change', (e) => {
    const wanted = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
    shell.classList.toggle('panel-collapsed', e.matches || wanted);
    sync();
  });
  sync();
}

// ---- panel resize and drop --------------------------------------------------

const PANEL_WIDTH_KEY = 'exceltools.panel.width';
const PANEL_MIN = 190;
const PANEL_MAX = 520;

/** Drag the seam between the panel and the work surface to resize it. A column
 *  of long column names needs a wider panel; a wide result grid needs a narrow
 *  one, and which you want changes several times an hour. */
function wirePanelResize(root: HTMLElement): void {
  const shell = root.querySelector<HTMLElement>('.app-shell')!;
  const grip = root.querySelector<HTMLElement>('#panelgrip')!;

  const apply = (px: number): void => {
    const w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, px)));
    shell.style.setProperty('--panel-w', `${w}px`);
    localStorage.setItem(PANEL_WIDTH_KEY, String(w));
  };
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (Number.isFinite(saved) && saved >= PANEL_MIN) apply(saved);

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-dragging');
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      grip.classList.remove('is-dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // Keyboard: a drag handle nobody can reach without a mouse is not a control.
  grip.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    const current = root.querySelector<HTMLElement>('#datapanel')!.getBoundingClientRect().width;
    apply(current + step);
  });
  grip.addEventListener('dblclick', () => {
    shell.style.removeProperty('--panel-w');
    localStorage.removeItem(PANEL_WIDTH_KEY);
  });
}

/** Dropping files on the panel is the same as dropping them on the drop area —
 *  the panel is where the files are listed, so it is where people aim. */
function wirePanelDrop(root: HTMLElement): void {
  const panel = root.querySelector<HTMLElement>('#datapanel')!;
  const stop = (e: DragEvent) => {
    if (!panelDrop) return;
    e.preventDefault();
    e.stopPropagation();
  };
  panel.addEventListener('dragover', (e) => {
    stop(e);
    if (panelDrop) panel.classList.add('is-dropping');
  });
  panel.addEventListener('dragleave', (e) => {
    if (e.target === panel) panel.classList.remove('is-dropping');
  });
  panel.addEventListener('drop', (e) => {
    panel.classList.remove('is-dropping');
    if (!panelDrop) return;
    stop(e);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) panelDrop(files);
  });
}

// ---- routing ----------------------------------------------------------------

function renderRoute(content: HTMLElement, route: Route): void {
  setAppStatus('Ready', 'success');
  closeDataPanel();
  setCrumb('');
  // The work surface is what scrolls now, and it survives a route change —
  // without this you arrive at a new tool halfway down it.
  content.scrollTop = 0;

  if (route.name === 'privacy') {
    currentToolId = null;
    setSwitcherLabel(null);
    renderHelp(null);
    import('./privacy').then(({ renderPrivacy }) => renderPrivacy(content));
    return;
  }
  if (route.name === 'home') {
    currentToolId = null;
    setSwitcherLabel(null);
    renderHelp(null);
    renderHome(content);
    return;
  }
  const tool = findTool(route.id);
  currentToolId = tool?.id ?? null;
  setSwitcherLabel(tool ?? null);
  renderHelp(tool ?? null);
  if (!tool) {
    content.innerHTML = `<div class="tool-body"><p class="empty">No tool called "${escapeHtml(route.id)}".</p></div>`;
    return;
  }
  if (tool.status === 'planned' || !tool.mount) {
    content.innerHTML = `
      <div class="tool-body">
        <div class="planned-note"><div>This tool is planned for a later phase. The engine and shell are ready — it plugs in here.</div></div>
      </div>`;
    return;
  }
  content.innerHTML = `<div class="tool-loading">Loading ${tool.title}…</div>`;
  Promise.resolve(tool.mount(content)).catch((e) => {
    // A failed chunk fetch usually means a stale cached shell after a deploy.
    // Reload once to pull the fresh index + chunks (guarded against loops).
    if (/dynamically imported module|Failed to fetch/i.test(String(e)) && !sessionStorage.getItem('xt-reloaded')) {
      sessionStorage.setItem('xt-reloaded', '1');
      location.reload();
      return;
    }
    toast(`${tool.title} could not load — try reloading the page. ${e}`, 'error', 8000);
    setAppStatus('Load failed', 'error');
  });
}

function renderHome(content: HTMLElement): void {
  const card = (t: ToolDef) => `
    <a class="tool-card ${t.status}" href="#/tool/${t.id}">
      <div class="tool-card-head">
        <span class="tool-card-icon">${iconTool(t.id)}</span>
        <span class="tool-card-title">${t.title}${t.status === 'planned' ? ' <span class="nav-tag">soon</span>' : ''}</span>
      </div>
      <span class="tool-card-blurb">${t.blurb}</span>
    </a>`;

  const grid = (tier: ToolDef['tier']) =>
    `<div class="card-grid">${TOOLS.filter((t) => t.tier === tier).map(card).join('')}</div>`;

  content.innerHTML = `
    <div class="tool-body">
      <div class="home-head">
        <h1>Spreadsheet tools</h1>
        <p>Everything runs on this computer — files are never uploaded. Choose a tool to begin.</p>
      </div>
      <div class="section-title"><span class="dot"></span><b>Quick tools</b><span>instant, no download</span></div>
      ${grid('light')}
      <div class="section-title sql"><span class="dot"></span><b>Data analysis tools</b><span>engine downloads once on first use, then works offline</span></div>
      ${grid('intermediate')}
    </div>`;
}
