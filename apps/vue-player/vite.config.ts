import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fromApp = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const isolatedAsset = (path: string | undefined) => path?.startsWith('/vendor/') || path?.startsWith('/assets/');

const documentIsolation: Plugin = {
  name: 'ubve-document-isolation',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? '/').split('?', 1)[0];
      if (path === '/isolated' || path?.startsWith('/isolated/') || path?.startsWith('/tests/')) {
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      } else if (isolatedAsset(path)) {
        // A dedicated worker requested by an isolated document needs its own compatible response.
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? '/').split('?', 1)[0];
      if (path === '/isolated' || path?.startsWith('/isolated/')) {
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      } else if (isolatedAsset(path)) {
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [vue(), documentIsolation],
  resolve: {
    alias: Object.fromEntries(['core', 'io-demux', 'wasm-adapters', 'native-bridge', 'presentation', 'disc', 'browser'].map(name => [`@ubve/${name}`, `${root}packages/${name}/src/index.ts`])),
  },
  server: {
    host: '127.0.0.1', port: 4173,
    fs: { allow: [root] },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    target: 'es2023', outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200,
    rolldownOptions: { input: { standard: fromApp('./index.html'), isolated: fromApp('./isolated/index.html') } },
  },
});
