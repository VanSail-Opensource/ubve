import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: Object.fromEntries(['core', 'io-demux', 'wasm-adapters', 'native-bridge', 'presentation', 'disc', 'browser'].map(name => [`@ubve/${name}`, `${root}packages/${name}/src/index.ts`])),
  },
  server: {
    host: '127.0.0.1', port: 4173,
    fs: { allow: [root] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    host: '127.0.0.1', port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: { target: 'es2023', outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200 },
});
