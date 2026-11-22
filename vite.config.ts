import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    host: true, // Listen on all local IPs
    port: 5173,
    https: true,
    cors: true,
    proxy: {
      '^/signaling': {
        target: 'ws://127.0.0.1:4444',
        ws: true,
        rewrite: (path) => path.replace(/^\/signaling/, '')
      }
    }
  },
  plugins: [
    tailwindcss(),
    basicSsl(),
    react()
  ],
  build: {
    rolldownOptions: {
      output: {
        // Stable vendor groups: framework and collaboration stack change on
        // different cadences than app code, so they get their own cached chunks.
        // (Vite 8 / rolldown replaced the object form of `manualChunks` with
        // `advancedChunks` groups.)
        advancedChunks: {
          groups: [
            { name: 'vendor-react', test: /\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\// },
            { name: 'vendor-yjs', test: /\/node_modules\/(yjs|y-webrtc|y-indexeddb|y-protocols|lib0)\// },
          ],
        },
      },
    },
  },
});