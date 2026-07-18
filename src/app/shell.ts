// App shell in Registry UI form: a product header (brand + runtime status +
// truthful privacy label), a compact tier-grouped nav, and one working surface
// that every tool mounts into. No nested cards — the workspace is the surface.
import { TOOLS, findTool, type ToolDef } from './registry';
import { onRouteChange, navigate, type Route } from './router';
import { toast } from '../ui/toast';
import { icon } from '../ui/icons';

type StatusState = 'success' | 'busy' | 'error';

let statusEl: HTMLElement | null = null;

/** Update the header runtime-status pill. Uses the fixed Registry vocabulary. */
export function setAppStatus(message: string, state: StatusState = 'success'): void {
  if (!statusEl) return;
  statusEl.className = `rgy-status rgy-status--${state}`;
  statusEl.querySelector('.rgy-status__text')!.textContent = message;
}

export function mountShell(root: HTMLElement): void {
  root.innerHTML = `
    <header class="rgy-header">
      <div class="rgy-header__inner rgy-container">
        <a class="rgy-brand" id="brand" href="#/" aria-label="ExcelTools home">
          <span class="rgy-brand__mark" aria-hidden="true">${icon('grid')}</span>
          <span>
            <strong class="rgy-brand__name">ExcelTools</strong>
            <small class="rgy-brand__tagline">Offline spreadsheet suite</small>
          </span>
        </a>
        <div class="rgy-status rgy-status--success" id="app-status" role="status" aria-live="polite">
          <span class="rgy-status__dot" aria-hidden="true"></span>
          <span class="rgy-status__text">Ready</span>
        </div>
        <div class="rgy-trust">
          ${icon('shield')}
          <span><strong>Private by design</strong><small>Files stay on this device</small></span>
        </div>
      </div>
    </header>
    <div class="app-body rgy-container">
      <aside class="app-nav"><nav class="app-nav-inner" id="nav" aria-label="Tools"></nav></aside>
      <main class="app-work" id="content" tabindex="-1"></main>
    </div>`;

  statusEl = root.querySelector<HTMLElement>('#app-status');
  buildNav(root.querySelector<HTMLElement>('#nav')!);
  root.querySelector('#brand')!.addEventListener('click', (e) => {
    e.preventDefault();
    navigate({ name: 'home' });
  });

  const content = root.querySelector<HTMLElement>('#content')!;
  onRouteChange((route) => renderRoute(content, route));
}

function buildNav(nav: HTMLElement): void {
  const label = { light: 'Light tools', intermediate: 'Intermediate tools' } as const;
  nav.innerHTML = (['light', 'intermediate'] as const)
    .map(
      (tier) => `
      <div class="nav-group-label">${label[tier]}</div>
      ${TOOLS.filter((t) => t.tier === tier)
        .map(
          (t) => `<a class="nav-item ${t.status}" href="#/tool/${t.id}" data-id="${t.id}">
                    <span class="nav-title">${t.title}</span>
                    ${t.status === 'planned' ? '<span class="nav-tag">soon</span>' : ''}
                  </a>`,
        )
        .join('')}`,
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
      <div class="planned-note">${icon('alert')}<div>This tool is planned for a later phase. The engine and shell are ready — it plugs in here.</div></div>`;
    return;
  }
  content.innerHTML = `<div class="tool-loading">Loading ${tool.title}…</div>`;
  Promise.resolve(tool.mount(content)).catch((e) => {
    toast(`${tool.title} could not load. ${e}`, 'error', 8000);
    setAppStatus('Error', 'error');
  });
}

function renderHome(content: HTMLElement): void {
  const row = (t: ToolDef) => `
    <a class="tool-row ${t.status}" href="#/tool/${t.id}">
      <span class="tool-row-name">${t.title}${t.status === 'planned' ? ' <span class="nav-tag">soon</span>' : ''}</span>
      <span class="tool-row-blurb">${t.blurb}</span>
      <span class="tool-row-open">${t.status === 'ready' ? 'Open →' : ''}</span>
    </a>`;

  const group = (tier: ToolDef['tier'], heading: string) => `
    <h2 class="section-title">${heading}</h2>
    <div class="tool-list">${TOOLS.filter((t) => t.tier === tier).map(row).join('')}</div>`;

  content.innerHTML = `
    <div class="home">
      <div class="home-head">
        <h1>Spreadsheet tools</h1>
        <p>Everything runs on this computer — files are never uploaded. Choose a tool to begin.</p>
      </div>
      ${group('light', 'Light tools')}
      ${group('intermediate', 'Intermediate tools')}
    </div>`;
}
