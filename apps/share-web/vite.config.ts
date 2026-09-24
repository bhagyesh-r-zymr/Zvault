import { defineConfig, loadEnv } from 'vite';

// The recipient page talks to exactly one origin: the Zvault API. The CSP is
// baked in at build time so a compromised CDN config can't loosen it.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiOrigin = new URL(env.VITE_API_URL ?? 'http://localhost:3000').origin;
  return {
    clearScreen: false,
    server: { port: 1430, strictPort: true },
    build: { target: 'es2022', sourcemap: false },
    define: { __API_ORIGIN__: JSON.stringify(apiOrigin) },
    plugins: [
      {
        name: 'zvault-csp',
        transformIndexHtml: (html) => html.replaceAll('__API_ORIGIN__', apiOrigin),
      },
    ],
  };
});
