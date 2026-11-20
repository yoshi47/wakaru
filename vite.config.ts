import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const src = resolve(import.meta.dirname, 'src');

export default defineConfig({
  root: src,
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    // Extension pages load files by fixed paths (manifest.json, chrome.runtime.getURL).
    rollupOptions: {
      input: {
        sidepanel: resolve(src, 'sidepanel/index.html'),
        background: resolve(src, 'background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
