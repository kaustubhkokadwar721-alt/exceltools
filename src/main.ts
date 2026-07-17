import './style.css';
import { mountShell } from './app/shell';
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui/toast';

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
