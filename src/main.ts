import './style.css';
import { mountShell } from './app/shell';
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui/toast';

// Recover from a stale cached shell: if a lazily-imported tool chunk 404s
// (its hash changed in a newer deploy), Vite fires `vite:preloadError`. Reload
// once to fetch the fresh index + chunks. The sessionStorage guard stops loops.
window.addEventListener('vite:preloadError', () => {
  if (!sessionStorage.getItem('xt-reloaded')) {
    sessionStorage.setItem('xt-reloaded', '1');
    location.reload();
  }
});

// Register the service worker for offline use. Silent auto-update; on a secure
// origin only (no-op under file://, which is fine — the app still runs).
registerSW({
  immediate: true,
  onOfflineReady() {
    toast('Ready to work offline.', 'success', 4000);
  },
});

const app = document.getElementById('app');
if (app) mountShell(app);
