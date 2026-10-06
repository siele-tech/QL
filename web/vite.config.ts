import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const apiPort = process.env.PORT || '4000';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  // Inline (empty) PostCSS config so Vite doesn't pick up a postcss.config.js from a parent folder.
  css: { postcss: {} },
  server: { port: 5173, proxy: { '/api': `http://localhost:${apiPort}` } },
  build: { outDir: path.resolve(import.meta.dirname, '../dist'), emptyOutDir: true },
});
