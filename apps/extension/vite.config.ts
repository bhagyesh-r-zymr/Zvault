import { defineConfig } from 'vite';

// The popup page and the background service worker. The content script is
// built on its own (vite.content.config.ts) because content scripts cannot
// load modules.
export default defineConfig({
  clearScreen: false,
  build: {
    target: 'es2022',
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: 'popup.html',
        background: 'src/background.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
