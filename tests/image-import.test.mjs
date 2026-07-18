import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePlaceholder, fitImageSize, imageFileId } from '../web/src/canvas/image-import.js';

test('图片展示尺寸只缩不放并保持比例', () => {
  assert.deepEqual(fitImageSize(1600, 800), { width: 480, height: 240 });
  assert.deepEqual(fitImageSize(120, 80), { width: 120, height: 80 });
  assert.deepEqual(fitImageSize(0, 0), { width: 1, height: 1 });
});

test('图片内容 id 为稳定 SHA-256，同内容同 id、不同内容不同 id', async () => {
  const a1 = await imageFileId(new TextEncoder().encode('same image'));
  const a2 = await imageFileId(new TextEncoder().encode('same image'));
  const b = await imageFileId(new TextEncoder().encode('other image'));
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^img_[0-9a-f]{64}$/);
});

test('图片占位同步可见但不提前引用未落仓 fileId', () => {
  const placeholder = createImagePlaceholder(40, 60, 'demo.png');
  assert.equal(placeholder.type, 'image');
  assert.equal(placeholder.fileId, null);
  assert.equal(placeholder.customData.importing, true);
  assert.equal(placeholder.customData.fileName, 'demo.png');
});
