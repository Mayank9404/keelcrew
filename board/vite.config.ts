import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The Keelcrew board build: the Keelcrew UI as one ES module per source file (dist/main.js and the rest) and one
 * stylesheet (dist/app.css); scripts/page.mjs then names each file by its content and writes the import map into
 * dist/index.html. Each module stays small enough for the Mate's subagent to read before publishing, and a release
 * adds only the modules it changed. React and three.js load from the CDN. Agent manifests and rules.json come from
 * ../plugins at build time.
 */
/** What the page loads from the CDN through its import map (scripts/page.mjs), so no module is too big to read. */
export const isExternal = (id: string): boolean => /^(three|react|react-dom)(\/|$)/.test(id);

/** One file per source module, named by its path (`components-chat-ChatPanel.js`), so a release changes only the
 * modules it touched. No leading `_`: the artifact service refuses published paths that start with one, and Vite's own
 * helper modules do (`_virtual/_vite/preload-helper`). */
export const flatName = (chunk: { name: string }): string => `${chunk.name.replace(/^.*?src\//, '').replace(/[^\w.-]+/g, '-').replace(/^_+/, '')}.js`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      external: isExternal,
      output: { format: 'es', preserveModules: true, preserveModulesRoot: 'src', entryFileNames: flatName, chunkFileNames: flatName, assetFileNames: (a) => (a.names?.[0]?.endsWith('.css') || a.name?.endsWith('.css') ? 'app.css' : '[name][extname]') },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
