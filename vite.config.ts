import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the built bundle runs from any subfolder, a network
// share, or file://-style internal hosting on locked-down work PCs.
export default defineConfig({
  base: './',
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
        globIgnores: ['**/duckdb-*'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // Cache the DuckDB chunk, workers and wasm the first time a Query/Pivot
        // tool loads them; they then stay available offline (CacheFirst).
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('duckdb') || url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'duckdb-engine',
              expiration: { maxEntries: 12 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'ExcelTools — Offline Suite',
        short_name: 'ExcelTools',
        description: 'Offline spreadsheet tools. Everything runs on your machine.',
        theme_color: '#1f6feb',
        background_color: '#0d1117',
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
