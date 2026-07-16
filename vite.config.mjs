/**
 * [INPUT]: 依赖 vite 与 @vitejs/plugin-react
 * [OUTPUT]: 对外提供 Vite 构建配置：root=web，产物 web/dist，Excal 远端字体 fallback 锁定移除、字体子集 worker 独立闭包，开发代理指向 :4517 后端
 * [POS]: 项目根的前端构建配置，连接 web/ 源码与 server 静态托管
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  EXCALIDRAW_SUBSET_WORKER_GROUPS, excalidrawLocalFonts,
} from './scripts/excalidraw-local-fonts.mjs';

export default defineConfig({
  root: 'web',
  plugins: [excalidrawLocalFonts(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: EXCALIDRAW_SUBSET_WORKER_GROUPS },
      },
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:4517' },
  },
});
