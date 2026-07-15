/**
 * [INPUT]: 依赖 vite 与 @vitejs/plugin-react
 * [OUTPUT]: 对外提供 Vite 构建配置：root=web，产物 web/dist，Excal 字体子集 worker 独立闭包，开发代理指向 :4517 后端
 * [POS]: 项目根的前端构建配置，连接 web/ 源码与 server 静态托管
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{
            name: 'excal-subset-worker',
            test: /node_modules[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:prod|dev)[\\/]subset-(?:worker|shared)\.chunk\.js$/,
            priority: 100,
            minSize: 0,
            includeDependenciesRecursively: true,
            entriesAware: true,
            entriesAwareMergeThreshold: 0,
          }],
        },
      },
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:4517' },
  },
});
