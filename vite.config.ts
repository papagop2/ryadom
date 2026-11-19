import { defineConfig } from 'vite';

const base = process.env.VITE_BASE || '/';
const outDir = process.env.VITE_OUT || '../dist';

export default defineConfig({
  base,
  root: 'web',
  server: { host: '127.0.0.1', proxy: { '/api/': 'http://127.0.0.1:3100' } },
  preview: { host: '127.0.0.1', proxy: { '/api/': 'http://127.0.0.1:3100' } },
  build: { outDir, emptyOutDir: true },
});
