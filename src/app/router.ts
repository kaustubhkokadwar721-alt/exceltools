// Minimal hash router. Hash-based so it works from any path depth, a network
// share, or file:// — no server rewrite rules needed (important for offline
// deployment on locked-down PCs).

export type Route = { name: 'home' } | { name: 'tool'; id: string };

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').trim();
  if (!clean) return { name: 'home' };
  const [section, id] = clean.split('/');
  if (section === 'tool' && id) return { name: 'tool', id };
  return { name: 'home' };
}

export function navigate(route: Route): void {
  location.hash = route.name === 'home' ? '#/' : `#/tool/${route.id}`;
}

export function onRouteChange(cb: (route: Route) => void): void {
  const fire = () => cb(parseHash(location.hash));
  window.addEventListener('hashchange', fire);
  fire();
}
