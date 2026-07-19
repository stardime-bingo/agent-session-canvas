/**
 * [INPUT]: 依赖 store.mjs 的 readJson/writeJson 原子原语，drawing-files.mjs 的资产规范化与引用收集
 * [OUTPUT]: 对外提供 createScene(dataDir) → { read, write, addFiles, rev }——LWW 快照仓
 * [POS]: 画布持久化唯一层。全量快照 + 原子写 + 内存 rev；无锁、无 journal、无 CAS——
 *        单写者本地工具的正确答案是"文件永远是完整快照"，不是两阶段提交
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';
import { drawingFileIds, normalizeDrawingFiles } from './drawing-files.mjs';

const EMPTY_CANVAS = Object.freeze({ edges: [], notes: [], boards: [], drawing: [] });

const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// 轻校验：挡住结构性垃圾（半截请求/类型错乱），不做逐字节公证——数据是哥的，不是法庭的
function checkCanvas(canvas) {
  if (!plainObject(canvas)) throw new Error('canvas 必须是对象');
  for (const key of ['edges', 'notes', 'boards', 'drawing']) {
    if (!Array.isArray(canvas[key])) throw new Error(`canvas.${key} 必须是数组`);
  }
  const ids = new Set();
  for (const el of canvas.drawing) {
    if (!plainObject(el) || typeof el.id !== 'string' || !el.id || ids.has(el.id)) {
      throw new Error('canvas.drawing 元素必须有唯一字符串 id');
    }
    ids.add(el.id);
  }
}

function checkLayout(layout) {
  if (!plainObject(layout)) throw new Error('layout 必须是对象');
  for (const [key, entry] of Object.entries(layout)) {
    if (!plainObject(entry)) throw new Error(`layout[${key}] 必须是对象`);
    for (const field of ['x', 'y', 'w', 'h']) {
      if (entry[field] !== undefined && !Number.isFinite(entry[field])) {
        throw new Error(`layout[${key}].${field} 必须是有限数`);
      }
    }
  }
}

export function createScene(dataDir) {
  const canvasFile = path.join(dataDir, 'canvas.json');
  const layoutFile = path.join(dataDir, 'layout.json');
  const filesFile = path.join(dataDir, 'drawing-files.json');
  fs.mkdirSync(dataDir, { recursive: true });

  // rev 只活在进程内存：它是 SSE 回声去重的序号，不是持久化真相的一部分
  let rev = 1;
  const writerSeq = new Map();

  const readCanvas = () => ({ ...structuredClone(EMPTY_CANVAS), ...readJson(canvasFile, {}) });
  const readFiles = () => normalizeDrawingFiles(readJson(filesFile, {}));

  return {
    get rev() { return rev; },

    read() {
      return {
        rev,
        layout: readJson(layoutFile, {}),
        canvas: readCanvas(),
        drawingFiles: readFiles(),
      };
    },

    // LWW 全量快照：后写者胜；同 writer 带 clientSeq 时，旧的在飞请求不得倒灌覆盖新快照。
    write({ layout, canvas, writerId, clientSeq }) {
      const ordered = typeof writerId === 'string' && writerId
        && Number.isSafeInteger(clientSeq) && clientSeq >= 0;
      if (ordered && clientSeq <= (writerSeq.get(writerId) ?? -1)) return { rev, stale: true };
      checkCanvas(canvas);
      checkLayout(layout);
      const files = readFiles();
      const missing = drawingFileIds(canvas.drawing).filter(id => !Object.hasOwn(files, id));
      if (missing.length) throw new Error(`绘图引用的图片不在仓内: ${missing[0]}`);
      writeJson(canvasFile, { edges: canvas.edges, notes: canvas.notes, boards: canvas.boards, drawing: canvas.drawing });
      writeJson(layoutFile, layout);
      // 孤儿图片顺手裁剪：只留仍被引用的资产，失败不影响本次提交
      const used = new Set(drawingFileIds(canvas.drawing));
      const pruned = Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id)));
      if (Object.keys(pruned).length !== Object.keys(files).length) {
        try { writeJson(filesFile, pruned); } catch { /* 孤儿资产无害，下次再裁 */ }
      }
      if (ordered) writerSeq.set(writerId, clientSeq);
      return { rev: ++rev };
    },

    // 图片资产内容寻址、同 ID 不可变：重复上传幂等，先上资产再提交引用
    addFiles(files) {
      const clean = normalizeDrawingFiles(files);
      if (!Object.keys(clean).length) return { added: 0 };
      const current = readFiles();
      let added = 0;
      for (const [id, file] of Object.entries(clean)) {
        if (!Object.hasOwn(current, id)) { current[id] = file; added++; }
      }
      if (added) writeJson(filesFile, current);
      return { added };
    },
  };
}
