import { defineConfig } from 'vitest/config';

// Unit tests exercise the pure logic modules (no DOM, no browser). Node env is
// enough — Blob/File/fflate all work under Node 20+.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: { include: ['src/core/transform.ts', 'src/core/validation.ts', 'src/core/zip.ts'] },
  },
});
