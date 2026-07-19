/**
 * [INPUT]: 依赖 api 的动作通道、ui 的 Icon/toast/confirmPop
 * [OUTPUT]: 对外提供八套右键菜单构建器（session/workspace/district/board/note/drawing/pane/edge）
 *           与三个删除流程（deleteSessionFlow/deleteBoardFlow/deleteNoteFlow）——菜单、节点按钮、详情面板共用同一条河
 * [POS]: canvas 的菜单与危险动作层。铁律：拉起/打开目录必有 toast 回执，删除必过自绘确认，绝不碰原生弹窗
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React from 'react';
import { api } from '../api.js';
import { handoffSkillPrompt } from '../util.js';
import { Icon, toast, confirmPop } from '../ui.jsx';
import { deleteDrawingElement, setDrawingElementPlane } from './drawing.js';

const L = (icon, text) => <><Icon name={icon} /> {text}</>;

// 拉起终端：成功有回执，失败说人话——右键菜单的动作不许无声无息
const launchGo = (payload, okMsg) =>
  api.launch(payload).then(() => toast(okMsg, 'ok')).catch(e => toast(`拉起失败：${e.message}`, 'error'));
const revealGo = target => api.reveal(target)
  .then(() => toast('已用默认文件管理器打开目录', 'ok'))
  .catch(e => toast(`打开目录失败：${e.message}`, 'error'));

// ============================================================
//  删除三流程：确认 → 执行 → 回执，一处定义各处共用
// ============================================================
export async function deleteSessionFlow(s, pos, onDone) {
  const ok = await confirmPop({
    x: pos?.x, y: pos?.y, danger: true, yesLabel: '移入废纸篓',
    text: `删除「${s.title}」？`,
    detail: (s.runs > 1 ? `⚙ 自动化聚合卡：${s.runs} 次运行实例将全部移入废纸篓。\n` : '')
      + '会话文件移入 macOS 废纸篓（可反悔），看板与 AI 增强数据即刻清除。',
  });
  if (!ok) return false;
  try {
    await api.del(s.key);
  } catch (e) {
    if (!e.message.includes('LIVE:')) { toast(`删除失败：${e.message}`, 'error'); return false; }
    // 活跃门禁拦截：给一次知情强删的机会
    const force = await confirmPop({
      x: pos?.x, y: pos?.y, danger: true, yesLabel: '强制删除',
      text: '该会话 10 分钟内仍有写入',
      detail: '可能正被 Claude Code / Codex 进程使用，强删可能丢失正在进行的工作。',
    });
    if (!force) return false;
    try { await api.del(s.key, true); }
    catch (e2) { toast(`删除失败：${e2.message}`, 'error'); return false; }
  }
  toast('已移入废纸篓', 'ok');
  onDone?.();
  return true;
}

export async function deleteBoardFlow(board, pos, onCanvasAction) {
  const ok = await confirmPop({
    x: pos?.x, y: pos?.y, danger: true, yesLabel: '删除画板',
    text: `删除画板「${board.name}」？`,
    detail: '里面的工作区会自动回到原街区，不会丢失。',
  });
  if (ok) onCanvasAction('delBoard', board.id);
}

export async function deleteNoteFlow(note, pos, onCanvasAction) {
  if (note.text?.trim()) {
    const ok = await confirmPop({
      x: pos?.x, y: pos?.y, danger: true, yesLabel: '删除',
      text: '删除这张写了字的便签？', detail: note.text.slice(0, 90),
    });
    if (!ok) return;
  }
  onCanvasAction('delNote', note.id);   // 空便签不值得一次打断
}

// ============================================================
//  菜单构建器：每种对象一套，item.fn(pos) 收到菜单坐标供确认层落位
// ============================================================
export const sessionMenu = (s, ctx) => [
  { label: L('play', '续开此会话'), fn: () => launchGo({ tool: s.tool, cwd: s.cwd, mode: 'resume', sessionId: s.id }, '已拉起终端：续开会话') },
  { label: L('plus', '同工作区新会话'), fn: () => launchGo({ tool: s.tool, cwd: s.cwd, mode: 'new' }, '已拉起终端：新会话') },
  { label: L('terminal', '打开会话上下文'), fn: pos => ctx.openContext?.(s.key, pos) },
  // 交接三件套：拉起 Claude 终端跑 bingo-agent-handoff 桥接救援——画布递地址，skill 出真相包，血缘自动连绿边
  { label: L('handoff', '交接三件套（终端）'), fn: () => launchGo(
    { tool: 'claude', cwd: s.cwd, mode: 'prompt', prompt: handoffSkillPrompt(s), sourceKey: s.key },
    '已拉起终端：桥接救援生成交接三件套（血缘已记）',
  ) },
  { label: L('panel', '打开详情面板'), fn: () => ctx.onSelect(s.key) },
  { label: L('edit', '重命名（同步本体）'), fn: () => ctx.rename(s.key) },
  { sep: true },
  { label: L('trash', '删除（入废纸篓）'), danger: true, fn: pos => deleteSessionFlow(s, pos, ctx.onChanged) },
];

export const workspaceMenu = (ws, ctx) => [
  { label: L('plus', 'Claude 新会话'), fn: () => launchGo({ tool: 'claude', cwd: ws.path, mode: 'new' }, '已拉起 Claude 新会话') },
  { label: L('plus', 'Codex 新会话'), fn: () => launchGo({ tool: 'codex', cwd: ws.path, mode: 'new' }, '已拉起 Codex 新会话') },
  { label: L('focus', '聚焦此工作区'), fn: () => ctx.focusWs(ws.path) },
  { label: L('folder', '用默认文件管理器打开'), fn: () => revealGo(ws.path) },
  { label: L('edit', '改名（看板显示）'), fn: () => ctx.rename(ws.path) },
];

export const districtMenu = (node, ctx) => [
  { label: L('focus', '聚焦此街区'), fn: () => ctx.focusDistrict(node) },
  { label: L('folder', '用默认文件管理器打开'), fn: () => revealGo(node.data._dir) },
  { label: L('board', '在此新建画板'), fn: pos => ctx.addBoardAt(pos) },
];

export const boardMenu = (b, ctx) => [
  { label: L('edit', '画板改名'), fn: () => ctx.rename(`board:${b.id}`) },
  { sep: true },
  { label: L('trash', '删除画板（成员回原街区）'), danger: true, fn: pos => deleteBoardFlow(b, pos, ctx.onCanvasAction) },
];

export const noteMenu = (n, ctx) => [
  { label: L('copy', '复制便签'), fn: () => ctx.onCanvasAction('setNote', {
    x: n.x + 30, y: n.y + 30, text: n.text, color: n.color,
    ...(n.w ? { w: n.w } : {}), ...(n.h ? { h: n.h } : {}),
  }) },
  { sep: true },
  { label: L('trash', '删除便签'), danger: true, fn: pos => deleteNoteFlow(n, pos, ctx.onCanvasAction) },
];

export const drawingMenu = (drawing, { enterSelection, mutateDrawing, store }) => [
  { label: drawing.customData?.below ? L('up', '浮到卡片上面') : L('down', '沉到卡片下面'), fn: () => {
    mutateDrawing(elements => setDrawingElementPlane(elements, drawing.id, !drawing.customData?.below));
    toast(drawing.customData?.below ? '已浮到卡片上面' : '已沉为背景底板——不再遮挡卡片点击', 'ok');
  } },
  { label: L('cursor', '选中编辑此绘图'), fn: () => enterSelection(drawing) },
  { label: L('trash', '删除此绘图'), danger: true, fn: async pos => {
    const ok = await confirmPop({
      x: pos?.x, y: pos?.y, danger: true, yesLabel: '删除',
      text: '删除这段绘图？', detail: '仅删除这一个绘图元素，画布其余笔迹不受影响。',
    });
    if (!ok) return;
    mutateDrawing(elements => deleteDrawingElement(elements, drawing.id));
    toast('绘图已删除', 'ok', { label: '撤销', onClick: () => store.undo() });
  } },
  { sep: true },
];

export const paneMenu = (at, ctx) => [
  { label: L('note', '在此新建便签'), fn: () => ctx.onCanvasAction('setNote', { ...at, text: '', color: 'yellow' }) },
  { label: L('board', '在此新建画板'), fn: () => ctx.onCanvasAction('setBoard', { ...at, w: 520, h: 360, name: '新画板' }) },
  { sep: true },
  { label: L('fit', '全景归位'), fn: () => ctx.fit() },
  { label: L('tidy', '自动整理布局'), fn: pos => ctx.arrange(pos) },
];

export const edgeMenu = (edge, ctx) => [
  { label: L('trash', '删除这条手动连线'), danger: true, fn: () => ctx.onCanvasAction('delEdge', edge.id) },
];
