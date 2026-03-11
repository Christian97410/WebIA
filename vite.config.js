import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
  },
});
