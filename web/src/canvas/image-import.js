/**
 * [INPUT]: 浏览器 image File/Blob、Web Crypto、图片落点
 * [OUTPUT]: 图片导入后台工序——同步占位元素、SHA-256 内容 id、data URL、原始尺寸与有界展示尺寸
 * [POS]: InkTools 的图片边界层；交互只创建占位，文件读取/哈希/解码全部异步回填
 * [PROTOCOL]: 变更时更新此头部，然后检查 web/CLAUDE.md
 */

const uid = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).slice(0, 21);

export function fitImageSize(width, height, maxSide = 480) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

export async function imageFileId(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('浏览器不支持图片内容寻址');
  const buffer = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = new Uint8Array(await subtle.digest('SHA-256', buffer));
  return `img_${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createImagePlaceholder(x, y, name = '图片') {
  return {
    id: uid(), type: 'image', x, y, width: 220, height: 140, angle: 0,
    strokeColor: '#98a2b3', backgroundColor: '#f2f4f7', strokeWidth: 1.5,
    opacity: 100, isDeleted: false, locked: false, fileId: null,
    groupIds: [], frameId: null, boundElements: null, seed: 1, version: 1,
    updated: Date.now(), customData: { importing: true, fileName: name },
  };
}

const readDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
  reader.readAsDataURL(file);
});

async function imageDimensions(file, dataURL) {
  if (globalThis.createImageBitmap) {
    const bitmap = await globalThis.createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions;
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataURL;
  });
}

export async function loadImageFile(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('只支持图片文件');
  const [bytes, dataURL] = await Promise.all([file.arrayBuffer(), readDataUrl(file)]);
  const [id, dimensions] = await Promise.all([imageFileId(bytes), imageDimensions(file, dataURL)]);
  return {
    id,
    file: { id, mimeType: file.type || 'application/octet-stream', dataURL, created: Date.now() },
    ...fitImageSize(dimensions.width, dimensions.height),
  };
}
