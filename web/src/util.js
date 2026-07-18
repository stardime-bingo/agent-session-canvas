/**
 * [INPUT]: 独立纯函数，无外部依赖
 * [OUTPUT]: 对外提供 relTime、shortPath、fmtSize、classifyDigestLine、handoffSkillPrompt(交接三件套提示词)、TOOL_META、STATUS_META
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

// ============================================================
//  digest 行分类：AI 摘录的行首标记 → 角色样式键
//  详情面板与画布终端框共用同一双眼睛
// ============================================================
export function classifyDigestLine(line) {
  if (line.startsWith('【')) return ['head', line];
  if (line.startsWith('[用户]')) return ['user', line.slice(4).trim()];
  if (line.startsWith('[助手]')) return ['assistant', line.slice(4).trim()];
  const t = line.trim();
  if (t.startsWith('▸')) return ['tool', t];
  if (t.startsWith('✗')) return ['error', t];
  return ['assistant', line];
}

// ============================================================
//  交接三件套提示词：把画布的"会话地址簿"优势交给 bingo-agent-handoff skill——
//  桥接救援模式恰恰需要"先定位源会话地址"，画布一键把精确地址递到嘴边。
//  提示词必须自包含（skill 铁律）：不依赖任何隐藏上下文，可直接复制进新会话。
// ============================================================
export function handoffSkillPrompt(s) {
  const resumeCmd = s.tool === 'claude' ? `claude --resume ${s.id}` : `codex resume ${s.id}`;
  return [
    '/bingo-agent-handoff 桥接救援（Bridge rescue）——只读，不要唤醒、修改或续写源会话。',
    '',
    '目标会话（AGENT 会话指挥塔已精确定位，无需再搜索）：',
    `- 工具：${s.tool === 'claude' ? 'Claude Code' : 'Codex'}`,
    `- 会话 ID：${s.id}`,
    `- 标题：${s.title || '（未命名）'}`,
    `- 源转录文件：${s.filePath}`,
    `- 项目根：${s.cwd}`,
    `- 恢复命令：${resumeCmd}`,
    '',
    '要求：',
    '1. 从源转录提取恢复胶囊；一切转录来源的断言标 REPORTED，不得未经验证升格 CONFIRMED。',
    '2. 运行 collect-project-state.sh 与任务相关检查，取得 CONFIRMED 现场证据。',
    '3. 产出完整交接包三件套：总汇报 / 施工接手提示词 / 独立只读审计提示词。',
    '4. 三件套自包含、可直接复制进新会话；范围红线与停止条件逐字保留。',
  ].join('\n');
}
