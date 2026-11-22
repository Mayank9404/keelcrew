import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { flatName } from '../vite.config';

/**
 * The dev fixture build: the board plus a fake runtime with example data, into dev-dist/ (never published), as the
 * same modules the real board loads.
 * `BOARD_REACT_DEV=1` builds React's development version, which logs key and effect warnings to the console.
 */
const reactDev = process.env.BOARD_REACT_DEV === '1';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify(reactDev ? 'development' : 'production') },
  build: {
    outDir: 'dev-dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./main.ts', import.meta.url)),
      // three.js comes from the CDN through the page's import map, as on the real board.
      external: (id: string) => /^three(\/|$)/.test(id),
      output: { format: 'es', preserveModules: true, entryFileNames: flatName, chunkFileNames: flatName, assetFileNames: (a) => (a.names?.[0]?.endsWith('.css') || a.name?.endsWith('.css') ? 'app.css' : '[name][extname]') },
    },
  },
});
