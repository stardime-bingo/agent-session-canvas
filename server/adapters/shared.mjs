/**
 * [INPUT]: 依赖 node:fs 的底层文件读取
 * [OUTPUT]: 对外提供 headLines、tailText、cleanPrompt、classifyStatus
 * [POS]: adapters 的公共工具箱，claude.mjs 与 codex.mjs 共享的解析原语——重复逻辑只写一次
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';

// ============================================================
//  局部读取原语：大文件只碰首尾，永不全量加载
// ============================================================
export function headLines(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.pop(); // 末行可能被截断，丢弃
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

export function tailText(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function sliceText(file, offset, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return '';
    const len = Math.min(size - offset, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================
//  提示词清洗：剥掉注入标签与命令噪音，留下人话
// ============================================================
export function cleanPrompt(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '')
    .replace(/^Caveat:.*$/m, '')
    .trim();
  if (!cleaned || cleaned.startsWith('<')) return null;
  return cleaned.slice(0, 200);
}

// ============================================================
//  状态分类：dead > tiny > active(7天内) > stale，规则单一无分支嵌套
// ============================================================
const ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;

export function classifyStatus({ dead, mtime, tiny, archived }) {
  if (archived) return 'archived';
  if (dead) return 'dead';
  if (tiny) return 'tiny';
  return (Date.now() - mtime.getTime() < ACTIVE_WINDOW_MS) ? 'active' : 'stale';
}
