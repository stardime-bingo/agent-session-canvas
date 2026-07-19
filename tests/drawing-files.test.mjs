/**
 * [INPUT]: server/drawing-files.mjs 规范化纯函数与 server/scene.mjs 场景仓
 * [OUTPUT]: BinaryFiles 规范化/引用收集回归 + 场景仓资产先行/不可变/多 writer 保守留存回归
 * [POS]: tests 的图片资产证伪层——资产永远先于引用落盘，普通 LWW 不破坏其他脏标签仍需的正文
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeDrawingFiles, drawingFileIds } from '../server/drawing-files.mjs';
import { createScene } from '../server/scene.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scene-files-'));
const img = (id, body = 'AAAA') => ({ [id]: { id, mimeType: 'image/png', dataURL: `data:image/png;base64,${body}`, created: 1 } });
const imageEl = (id, fileId) => ({ id, type: 'image', fileId, x: 0, y: 0, width: 10, height: 10 });
const emptyCanvas = { edges: [], notes: [], boards: [], drawing: [] };

test('normalizeDrawingFiles 只留合法 data URL 与 ID，剥掉杂字段', () => {
  const clean = normalizeDrawingFiles({
    ok: { dataURL: 'data:image/png;base64,AA', mimeType: 'image/png', junk: true },
    'bad id!': { dataURL: 'data:image/png;base64,AA' },
    noUrl: { mimeType: 'image/png' },
    httpUrl: { dataURL: 'https://evil/x.png' },
  });
  assert.deepEqual(Object.keys(clean), ['ok']);
  assert.equal(clean.ok.junk, undefined);
  assert.equal(clean.ok.mimeType, 'image/png');
});

test('drawingFileIds 只收活着的 image 元素引用，去重排序', () => {
  assert.deepEqual(drawingFileIds([
    imageEl('a', 'f2'), imageEl('b', 'f1'), { ...imageEl('c', 'f9'), isDeleted: true },
    imageEl('d', 'f1'), { id: 'e', type: 'rectangle' },
  ]), ['f1', 'f2']);
});

test('场景仓：引用缺失的写被拒，资产先行后写成功，rev 单调推进', () => {
  const dir = tmpDir();
  const scene = createScene(dir);
  const withImage = { ...emptyCanvas, drawing: [imageEl('el1', 'f1')] };
  assert.throws(() => scene.write({ layout: {}, canvas: withImage }), /图片不在仓内/);
  assert.deepEqual(scene.addFiles(img('f1')), { added: 1 });
  const { rev } = scene.write({ layout: {}, canvas: withImage });
  assert.equal(rev, 2);
  const read = scene.read();
  assert.equal(read.rev, 2);
  assert.ok(read.updatedAt > 0);
  assert.equal(fs.statSync(path.join(dir, 'canvas.json')).mtimeMs, read.updatedAt);
  assert.equal(read.canvas.drawing.length, 1);
  assert.ok(read.drawingFiles.f1);
});

test('场景仓：同 ID 资产不可变，普通 LWW 写保留未引用正文供其他脏标签追平', () => {
  const dir = tmpDir();
  const scene = createScene(dir);
  scene.addFiles(img('f1', 'FIRST'));
  scene.addFiles({ ...img('f1', 'SECOND'), ...img('f2') });
  const files = scene.read().drawingFiles;
  assert.match(files.f1.dataURL, /FIRST/);   // 首份内容胜，二次上传不覆盖
  assert.ok(files.f2);
  // writer B 看不见 writer A 的脏本地引用：空图 LWW 不得破坏已上传的内容寻址正文。
  scene.write({ layout: {}, canvas: { ...emptyCanvas, drawing: [imageEl('el1', 'f1')] } });
  scene.write({ layout: {}, canvas: emptyCanvas, writerId: 'writer-b', clientSeq: 1 });
  const retained = JSON.parse(fs.readFileSync(path.join(dir, 'drawing-files.json'), 'utf8'));
  assert.deepEqual(Object.keys(retained).sort(), ['f1', 'f2']);
  assert.doesNotThrow(() => scene.write({
    layout: {}, canvas: { ...emptyCanvas, drawing: [imageEl('el-a', 'f1')] },
    writerId: 'writer-a', clientSeq: 2,
  }));
});

test('场景仓：结构性垃圾被拒且磁盘零字节变化', () => {
  const dir = tmpDir();
  const scene = createScene(dir);
  scene.write({ layout: { a: { x: 1, y: 2 } }, canvas: emptyCanvas });
  const before = fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8');
  assert.throws(() => scene.write({ layout: {}, canvas: { ...emptyCanvas, notes: 'bad' } }), /必须是数组/);
  assert.throws(() => scene.write({ layout: { a: { x: Infinity } }, canvas: emptyCanvas }), /有限数/);
  assert.throws(() => scene.write({
    layout: {}, canvas: { ...emptyCanvas, drawing: [{ id: 'dup' }, { id: 'dup' }] },
  }), /唯一字符串 id/);
  assert.equal(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8'), before);
});

test('场景仓：同 writer 的旧在飞快照不能倒灌覆盖较新的 clientSeq', () => {
  const scene = createScene(tmpDir());
  const canvas = text => ({ ...emptyCanvas, notes: [{ id: 'n', text }] });
  const newer = scene.write({ layout: {}, canvas: canvas('final'), writerId: 'writer-a', clientSeq: 3 });
  const stale = scene.write({ layout: {}, canvas: canvas('old'), writerId: 'writer-a', clientSeq: 2 });
  assert.equal(newer.rev, 2);
  assert.deepEqual(stale, { rev: 2, stale: true });
  assert.equal(scene.read().canvas.notes[0].text, 'final');
});
