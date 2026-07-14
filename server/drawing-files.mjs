/**
 * [INPUT]: 依赖 store 的 JSON 原子读写与 data 目录
 * [OUTPUT]: 提供 Excalidraw BinaryFiles 的校验、独立落盘与回读
 * [POS]: server 的绘图图片资产仓；与轻量 canvas.json 分离，避免移动便签时反复重写大图
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeDrawingFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return {};
  const clean = {};
  for (const [id, file] of Object.entries(files)) {
    if (!FILE_ID.test(id) || !file || typeof file !== 'object') continue;
    if (typeof file.dataURL !== 'string' || !file.dataURL.startsWith('data:')) continue;
    clean[id] = {
      id,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
      dataURL: file.dataURL,
      created: Number.isFinite(file.created) ? file.created : Date.now(),
      ...(Number.isFinite(file.lastRetrieved) ? { lastRetrieved: file.lastRetrieved } : {}),
    };
  }
  return clean;
}

export function loadDrawingFiles(dataDir) {
  return normalizeDrawingFiles(readJson(path.join(dataDir, 'drawing-files.json'), {}));
}

export function saveDrawingFiles(dataDir, files) {
  const clean = normalizeDrawingFiles(files);
  writeJson(path.join(dataDir, 'drawing-files.json'), clean);
  return clean;
}
