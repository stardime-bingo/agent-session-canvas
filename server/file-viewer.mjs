/**
 * [INPUT]: macOS 全局 NSFileViewer 偏好、待打开的绝对本地路径、/usr/bin/open
 * [OUTPUT]: revealInDefaultFileViewer——优先交给用户配置的文件管理器；未配置/Finder/失效配置安全回退系统打开
 * [POS]: server 的桌面文件管理器边界；不把 Finder 或任何第三方工具硬编码进产品行为
 * [PROTOCOL]: 变更时更新此头部，然后检查 server/CLAUDE.md
 */
import { execFile } from 'node:child_process';

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const runFile = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'utf8', timeout: 5000 }, (error, stdout, stderr) => {
    if (error) {
      error.stderr = stderr;
      reject(error);
    } else resolve({ stdout, stderr });
  });
});

export function normalizeFileViewer(value) {
  const bundleId = String(value || '').trim();
  if (!bundleId || !BUNDLE_ID.test(bundleId) || bundleId.toLowerCase() === 'com.apple.finder') return null;
  return bundleId;
}

export function fileViewerOpenArgs(target, bundleId) {
  const viewer = normalizeFileViewer(bundleId);
  return viewer ? ['-b', viewer, target] : [target];
}

export async function revealInDefaultFileViewer(target, { execute = runFile } = {}) {
  let configured = null;
  try {
    const result = await execute('/usr/bin/defaults', ['read', '-g', 'NSFileViewer']);
    configured = normalizeFileViewer(result.stdout);
  } catch { /* 没有显式替代工具时，open 交给系统默认行为 */ }

  try {
    await execute('/usr/bin/open', fileViewerOpenArgs(target, configured));
    return { ok: true, opener: configured || 'system' };
  } catch (error) {
    if (!configured) throw error;
    // 用户偏好可能指向已卸载应用；此时仍要让目录可达，而不是让按钮失效。
    await execute('/usr/bin/open', [target]);
    return { ok: true, opener: 'system', fallbackFrom: configured };
  }
}
