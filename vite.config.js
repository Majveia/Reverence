import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, strictPort: false, hmr: { overlay: false } },
  worker: { format: 'es' },
  // three is native ESM: serve it raw so parallel agents adding addon imports never trigger
  // a dependency re-optimization (which reloads every open page mid-capture).
  optimizeDeps: { exclude: ['three'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  assetsInclude: ['**/*.glsl'],
});
