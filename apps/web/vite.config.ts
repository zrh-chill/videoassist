import { defineConfig } from 'vite';
import { loadConfig } from '../../packages/config/src/index.js';
const config = loadConfig();
export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: {
    '/api': { target: 'http://127.0.0.1:' + config.port, changeOrigin: true },
    '/health': { target: 'http://127.0.0.1:' + config.port, changeOrigin: true },
  } },
});
