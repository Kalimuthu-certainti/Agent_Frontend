import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Local builds are served from the site root by src/server.js. The Pages
  // workflow overrides this with VITE_BASE=/Agent_Frontend/ for the subpath.
  base: process.env.VITE_BASE || '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:4180' } },
});
