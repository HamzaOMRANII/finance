// CommonJS on purpose: the package isn't "type": "module", so pm2 can require() the ecosystem configs.
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react').default;

// Client source lives in src/client; index.html at the root is the entry.
// `npm run build` writes dist/, which src/server.js serves in production.
// In dev, /api is proxied to a local `npm start` (PORT 17000).
module.exports = defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:17000' },
  },
});
