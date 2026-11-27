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
        micPermission: resolve(src, 'sidepanel/mic-permission.html'),
        background: resolve(src, 'background.ts'),
        // `pnpm build:harness`: the page that plays dev/overlap.json into a Session.
        ...(process.env.WAKARU_HARNESS ? { harness: resolve(src, 'dev/harness.html') } : {}),
      },
      output: {
        // `background.js` stays fixed (manifest.json names it); everything else gets a content
        // hash, so an extension reload cannot keep a stale stylesheet or script from an old build.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : '[name]-[hash].js'),
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
