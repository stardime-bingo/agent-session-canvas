/**
 * [INPUT]: 独立纯函数，无外部依赖
 * [OUTPUT]: 对外提供 relTime、shortPath、fmtSize、TOOL_META、STATUS_META
 * [POS]: web 的展示层工具箱与文案常量，组件共享
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const TOOL_META = {
  claude: { label: 'CLAUDE', color: 'var(--claude)' },
  codex: { label: 'CODEX', color: 'var(--codex)' },
};

export const STATUS_META = {
  active: '活跃', dead: '死亡', stale: '沉寂', tiny: '空壳', archived: '归档',
};

export function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function shortPath(p, keep = 3) {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= keep ? p : '…/' + parts.slice(-keep).join('/');
}

export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
