/**
 * [INPUT]: 本仓 Vite/React 与 tests/fixtures/canvas-acceptance
 * [OUTPUT]: 只绑 127.0.0.1:4518 的无代理、/api 拒绝的隔离验收页
 * [POS]: 画布实机验收唯一启动器；不连 4517，不读写 data
 * [PROTOCOL]: 变更时更新此头部，然后检查 fixture README/AGENTS.md
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'tests/fixtures/canvas-acceptance');
const isolateApi = {
  name: 'canvas-acceptance-isolate-api',
  enforce: 'pre',
  configureServer(server) {
    server.middlewares.use('/api', (_request, response) => {
      response.statusCode = 403;
      response.end('canvas acceptance fixture has no API');
    });
  },
};
const server = await createServer({
  root: fixture,
  publicDir: path.join(repo, 'web/public'),
  plugins: [isolateApi, react()],
  appType: 'spa',
  clearScreen: false,
  server: { host: '127.0.0.1', port: 4518, strictPort: true, fs: { allow: [repo] } },
});
await server.listen();
server.printUrls();

const close = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
