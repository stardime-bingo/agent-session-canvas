/**
 * [INPUT]: 依赖 @excalidraw/excalidraw npm 包内的生产字体
 * [OUTPUT]: 构建前同步到 web/public/fonts，供本地 Excalidraw 离线加载
 * [POS]: 发布资产准备脚本；字体来源由 package-lock 固定，不在 Git 重复 vendoring
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
const target = path.join(root, 'web', 'public', 'fonts');

if (!fs.existsSync(source)) {
  throw new Error('缺少 Excalidraw 字体，请先运行 npm ci');
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
