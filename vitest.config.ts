import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Vitest stubs .css modules to '' by default — even through a `?raw` glob.
    // Starter stylesheets are test fixtures (content under test), so process them.
    css: { include: [/\/public\/starters\//] },
  },
  resolve: {
    alias: { '@': '/src' },
  },
});