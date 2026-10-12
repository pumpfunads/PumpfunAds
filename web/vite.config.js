import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.dirname(new URL(import.meta.url).pathname),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5421, proxy: { '/api': { target: 'http://127.0.0.1:5420', changeOrigin: false } } },
});
