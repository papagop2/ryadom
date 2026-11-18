import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: { host: '127.0.0.1', proxy: { '/api/': 'http://127.0.0.1:3100' } },
  preview: { host: '127.0.0.1', proxy: { '/api/': 'http://127.0.0.1:3100' } },
  build: { outDir: '../dist', emptyOutDir: true },
});
