import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React and the canvas library change rarely: their own files stay cached when the app code changes.
        manualChunks: (id) => (id.includes('node_modules') ? (/@xyflow|d3-/.test(id) ? 'canvas' : /react|scheduler/.test(id) ? 'vendor' : undefined) : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/webhook': 'http://localhost:3000',
    },
  },
});
