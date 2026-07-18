// App shell: sidebar + content area, route handling, and the home grid of
// tools. This is the frame every tool mounts into.
import { TOOLS, findTool, type ToolDef } from './registry';
import { onRouteChange, navigate, type Route } from './router';
import { toast } from '../ui/toast';

export function mountShell(root: HTMLElement): void {
  root.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand" id="brand">
          <span class="brand-mark">▦</span>
          <span class="brand-name">ExcelTools</span>
        </div>
        <nav class="nav" id="nav"></nav>
        <div class="sidebar-foot">
          <div class="offline-badge" id="offline-badge">● Local-only</div>
          <div class="foot-note">Everything runs on this PC.<br/>Nothing is uploaded.</div>
        </div>
      </aside>
      <main class="content" id="content"></main>
    </div>`;

  buildNav(root.querySelector<HTMLElement>('#nav')!);
  root.querySelector('#brand')!.addEventListener('click', () => navigate({ name: 'home' }));

  const content = root.querySelector<HTMLElement>('#content')!;
  onRouteChange((route) => renderRoute(content, route));
}

function buildNav(nav: HTMLElement): void {
  const groups: Record<string, ToolDef[]> = {
    light: TOOLS.filter((t) => t.tier === 'light'),
    intermediate: TOOLS.filter((t) => t.tier === 'intermediate'),
  };
  const label = { light: 'Light tools', intermediate: 'Intermediate tools' };
  nav.innerHTML = (['light', 'intermediate'] as const)
    .map(
      (tier) => `
      <div class="nav-group-label">${label[tier]}</div>
      ${groups[tier]
        .map(
          (t) => `<a class="nav-item ${t.status}" href="#/tool/${t.id}" data-id="${t.id}">
                    <span class="nav-icon">${t.icon}</span>
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
  if (route.name === 'home') {
    setActiveNav(null);
    renderHome(content);
    return;
  }
  const tool = findTool(route.id);
  setActiveNav(tool?.id ?? null);
  if (!tool) {
    content.innerHTML = `<div class="notfound"><h2>Unknown tool</h2><p>No tool called "${route.id}".</p></div>`;
    return;
  }
  if (tool.status === 'planned' || !tool.mount) {
    content.innerHTML = `
      <div class="tool-head"><h2>${tool.icon} ${tool.title}</h2>
      <p class="tool-blurb">${tool.blurb}</p></div>
      <div class="planned-note">This tool is planned for a later phase. The core engine and shell are ready — it plugs in here.</div>`;
    return;
  }
  content.innerHTML = `<div class="tool-loading">Loading ${tool.title}…</div>`;
  Promise.resolve(tool.mount(content)).catch((e) => {
    toast(`Failed to load ${tool.title}: ${e}`, 'error', 8000);
  });
}

function renderHome(content: HTMLElement): void {
  const card = (t: ToolDef) => `
    <a class="tool-card ${t.status}" href="#/tool/${t.id}">
      <div class="tool-card-icon">${t.icon}</div>
      <div class="tool-card-body">
        <div class="tool-card-title">${t.title} ${t.status === 'planned' ? '<span class="nav-tag">soon</span>' : ''}</div>
        <div class="tool-card-blurb">${t.blurb}</div>
      </div>
    </a>`;

  content.innerHTML = `
    <div class="home">
      <header class="home-head">
        <h1>ExcelTools</h1>
        <p>An offline suite of spreadsheet tools. Every file is processed on this
           computer — nothing is ever uploaded.</p>
      </header>
      <section>
        <h3 class="section-title">Light tools</h3>
        <div class="card-grid">${TOOLS.filter((t) => t.tier === 'light').map(card).join('')}</div>
      </section>
      <section>
        <h3 class="section-title">Intermediate tools</h3>
        <div class="card-grid">${TOOLS.filter((t) => t.tier === 'intermediate').map(card).join('')}</div>
      </section>
    </div>`;
}
