import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  /**
   * `serve` → `/` so `npm run dev` resolves modules and `@vite/client` reliably.
   * `build` → `./` so `dist/` works on GitHub Pages and static hosts.
   */
  base: command === 'serve' ? '/' : './',
  server: { open: true },
  publicDir: 'public',
  build: {
    chunkSizeWarningLimit: 700,
  },
}));
