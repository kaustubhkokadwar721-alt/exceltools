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
      // Precache everything so the app is fully usable with zero network.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // Large because bundled WASM engines can be sizeable; offline is the goal.
        maximumFileSizeToCacheInBytes: 60 * 1024 * 1024,
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
