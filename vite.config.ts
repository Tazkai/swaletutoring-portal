import { defineConfig } from 'vite';

// The client lives in src/client; the service worker is built as an unhashed
// /sw.js so the browser can find it at a stable URL.
export default defineConfig({
  root: 'src/client',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'src/client/index.html',
        sw: 'src/client/sw.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
