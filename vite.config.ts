import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static, read-only dashboard. No dev proxy — data comes from public/data/*.
// base defaults to '/Agent_Frontend/' for project Pages; set VITE_BASE='/' to
// serve at a domain root.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/Agent_Frontend/',
  build: { outDir: 'dist', emptyOutDir: true },
});
