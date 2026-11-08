import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The client calls /api/* on its own origin in every environment; in dev the
    // proxy forwards to the Worker dev server (worker/dev/dev-server.mjs) so
    // there is no CORS special-casing.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:8788',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Source maps are left out of production so the original code is not served publicly.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Rarely changes, so browsers keep it cached across deploys.
        manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
});
