import { defineConfig } from 'vite';

export default defineConfig({
  /** Works on GitHub Pages (`/repo/`) and any static host without path bugs. */
  base: './',
  server: { open: true },
  publicDir: 'public',
  build: {
    chunkSizeWarningLimit: 700,
  },
});
