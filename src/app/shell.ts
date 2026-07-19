// App shell: left sidebar (brand, tier-grouped nav, engine + privacy cards,
// offline footer) and one working surface every tool mounts into. Warm register
// theme; content is the real tool set.
import { TOOLS, findTool, type ToolDef } from './registry';
import { onRouteChange, navigate, type Route } from './router';
import { toast } from '../ui/toast';
import { iconTool } from '../ui/icons';

type StatusState = 'success' | 'busy' | 'error';
let engineCard: HTMLElement | null = null;

/** Update the sidebar engine card (runtime status). */
export function setAppStatus(message: string, state: StatusState = 'success'): void {
  if (!engineCard) return;
  const dot = engineCard.querySelector<HTMLElement>('.dot')!;
  const txt = engineCard.querySelector<HTMLElement>('.txt')!;
  const body = engineCard.querySelector<HTMLElement>('.side-card-body')!;
  const color = state === 'error' ? 'var(--rgy-red)' : state === 'busy' ? 'var(--rgy-gold)' : 'var(--rgy-green)';
  dot.style.background = color;
  if (state === 'success') {
    txt.textContent = 'Engine ready';
    body.textContent = 'SQL engine loads on first use';
  } else {
    txt.textContent = message;
    if (state === 'error') body.textContent = 'Reload and try again';
  }
}

export function mountShell(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app-shell">
      <aside class="app-nav">
        <div class="brand" id="brand">
          <span class="brand-mark" aria-hidden="true">Xt</span>
          <span>
            <span class="brand-name" style="display:block">ExcelTools</span>
            <span class="brand-tagline" style="display:block">Offline spreadsheet suite</span>
          </span>
        </div>
        <nav id="nav" aria-label="Tools"></nav>
        <div class="side-card" id="engine">
          <div class="side-card-title"><span class="dot"></span><span class="txt">Engine ready</span></div>
          <div class="side-card-body">SQL engine loads on first use</div>
        </div>
        <div class="side-card">
          <div class="side-card-title"><span class="dot"></span>PRIVATE BY DESIGN</div>
          <div class="side-card-body">Your files are read on this computer and nowhere else. Nothing is uploaded — switch off Wi-Fi and keep working.</div>
        </div>
        <div class="side-foot"><span class="dot"></span>Offline · nothing leaves this device</div>
      </aside>
      <main class="app-work" id="content" tabindex="-1"></main>
    </div>`;

  engineCard = root.querySelector<HTMLElement>('#engine');
  buildNav(root.querySelector<HTMLElement>('#nav')!);
  root.querySelector('#brand')!.addEventListener('click', () => navigate({ name: 'home' }));

  const content = root.querySelector<HTMLElement>('#content')!;
  onRouteChange((route) => renderRoute(content, route));
}

function buildNav(nav: HTMLElement): void {
  const groups = [
    { tier: 'light' as const, label: 'Light tools', cls: '' },
    { tier: 'intermediate' as const, label: 'SQL Engine', cls: 'sql' },
  ];
  nav.innerHTML = groups
    .map(
      (g) => `
      <div class="nav-group-label ${g.cls}"><span class="dot"></span>${g.label}</div>
      <div class="nav-group">
        ${TOOLS.filter((t) => t.tier === g.tier)
          .map(
            (t) => `<a class="nav-item ${t.status}" href="#/tool/${t.id}" data-id="${t.id}">
                      <span class="nav-title">${t.title}</span>
                      ${t.id === 'query' ? '<span class="nav-meta">⌘↩</span>' : t.status === 'planned' ? '<span class="nav-tag">soon</span>' : ''}
                    </a>`,
          )
          .join('')}
      </div>`,
    )
    .join('');
}

function setActiveNav(id: string | null): void {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.id === id);
  });
}

function renderRoute(content: HTMLElement, route: Route): void {
  setAppStatus('Ready', 'success');
  if (route.name === 'home') {
    setActiveNav(null);
    renderHome(content);
    return;
  }
  const tool = findTool(route.id);
  setActiveNav(tool?.id ?? null);
  if (!tool) {
    content.innerHTML = `<div class="tool-head"><h2>Unknown tool</h2></div><p class="tool-blurb">No tool called "${route.id}".</p>`;
    return;
  }
  if (tool.status === 'planned' || !tool.mount) {
    content.innerHTML = `
      <div class="tool-head"><h2>${tool.title}</h2></div>
      <p class="tool-blurb">${tool.blurb}</p>
      <div class="planned-note"><div>This tool is planned for a later phase. The engine and shell are ready — it plugs in here.</div></div>`;
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
    <div class="home-head">
      <h1>Spreadsheet tools</h1>
      <p>Everything runs on this computer — files are never uploaded. Choose a tool to begin.</p>
    </div>
    <div class="section-title"><span class="dot"></span><b>Light tools</b><span>instant, no download</span></div>
    ${grid('light')}
    <div class="section-title sql"><span class="dot"></span><b>SQL Engine</b><span>downloads once on first use, then works offline</span></div>
    ${grid('intermediate')}`;
}
