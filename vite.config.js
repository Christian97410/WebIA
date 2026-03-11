import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      external: [
        '@tauri-apps/api/core',
        '@tauri-apps/api/event',
        '@tauri-apps/plugin-shell',
      ],
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
});
