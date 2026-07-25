import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// Stamped into exports so a figure in a workpaper can be traced back to the
// exact build that produced it. Read at build time; never goes stale.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Relative base so the built bundle runs from any subfolder, a network
// share, or file://-style internal hosting on locked-down work PCs.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  build: {
    target: 'es2022',
    // SheetJS is imported only inside the parser worker, so it already lands in
    // its own worker chunk and never weighs down the main bundle. Tier-2 engines
    // (Phase 3) will be code-split via dynamic import() at their call sites.
  },
  worker: {
    format: 'es',
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Precache the light app shell + tools only (~small). The heavy DuckDB
        // engine (~40 MB of wasm) is deliberately excluded so light-tool users
        // never pay for it; it is runtime-cached on first Tier-2 use instead.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/duckdb-*', 'pyodide/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // Self-heal across deploys: a new SW activates immediately, takes over
        // open tabs, and purges the previous precache — so a returning client
        // never serves a stale index that points at removed chunk hashes.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Cache the DuckDB chunk, workers and wasm the first time a Query/Pivot
        // tool loads them; they then stay available offline (CacheFirst).
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('duckdb') || url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'duckdb-engine',
              expiration: { maxEntries: 12 },
              cacheableResponse: { statuses: [200] }, // never cache opaque responses
            },
          },
          {
            // Python engine (Pyodide core + wheels): cached on first use of the
            // Python tool, then available offline. Excluded from precache above.
            urlPattern: ({ url }) => url.pathname.includes('/pyodide/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'python-engine',
              expiration: { maxEntries: 24 },
              cacheableResponse: { statuses: [200] }, // never cache opaque responses
            },
          },
        ],
      },
      manifest: {
        name: 'ExcelTools — Offline Suite',
        short_name: 'ExcelTools',
        description: 'Offline spreadsheet tools. Everything runs on your machine.',
        theme_color: '#1f5c3d',
        background_color: '#f7f4eb',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
});
