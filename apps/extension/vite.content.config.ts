import { defineConfig } from 'vite';

// The content script, as one classic script with nothing to import.
export default defineConfig({
  clearScreen: false,
  publicDir: false,
  build: {
    target: 'es2022',
    sourcemap: false,
    emptyOutDir: false,
    lib: {
      entry: 'src/content.ts',
      formats: ['iife'],
      name: 'zvaultContent',
      fileName: () => 'content.js',
    },
  },
});
