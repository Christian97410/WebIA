import { defineConfig } from 'vite';
import { resolve } from 'path';

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
