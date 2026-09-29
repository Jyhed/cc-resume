import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { demoSnapshot } from './demo/snapshot.js';

// In a plain browser (`npm run dev` without Tauri) the UI previews a snapshot of your own chats,
// written by `cc-resume --dump-snapshot .dev/snapshot.json` (it holds real chat names, so it never
// ships). Without one, or with CCR_DEMO=1, it shows the made-up machine in demo/snapshot.js.
const previewSnapshot = {
  name: 'preview-snapshot',
  configureServer(server) {
    server.middlewares.use('/__snapshot', async (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (!process.env.CCR_DEMO) {
        try {
          res.end(await readFile('.dev/snapshot.json'));
          return;
        } catch { /* no dump yet: the demo stands in */ }
      }
      res.end(JSON.stringify(demoSnapshot()));
    });
  },
};

export default defineConfig({
  plugins: [previewSnapshot],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/board/**', '**/proposals/**', '**/docs/**'] } },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
