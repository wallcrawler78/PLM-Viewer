import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'viewer-development-service',
    apply: 'serve',
    async configureServer(server) {
      // Node-only development middleware. No provider module or credentials enter the client bundle.
      // The production deployment mounts this same BFF behind an authenticated same-origin route.
      const env = loadEnv(mode, process.cwd(), 'ARENA_');
      const serviceModule = pathToFileURL(resolve('server/index.mjs')).href;
      const { createViewerServer, loadConfiguredProvider } = await import(serviceModule);
      const provider = await loadConfiguredProvider(process.env.ARENA_PROVIDER_MODULE ?? env.ARENA_PROVIDER_MODULE);
      const { loadConfiguredPlayground } = await import(pathToFileURL(resolve('server/playground.mjs')).href);
      const playgroundEnv = { ...loadEnv(mode, process.cwd(), 'PLAYGROUND_'), ...process.env };
      const service = createViewerServer(provider, loadConfiguredPlayground(playgroundEnv));
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith('/api/viewer/v1/')) service.emit('request', request, response);
        else next();
      });
      server.httpServer?.once('close', () => service.removeAllListeners());
    },
  }],
  build: { chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
}));
