import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The api serves the built assets, so dev runs against a real api rather than a mock.
export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  server: { proxy: { '/admin': 'http://localhost:3000', '/metrics': 'http://localhost:3000' } },
});
