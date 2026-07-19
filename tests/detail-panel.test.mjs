/**
 * [INPUT]: web/src/panels/DetailPanel.jsx 的详情侧栏 JSX 顺序
 * [OUTPUT]: 接力/元信息/删除固定在长内容之前，并提供醒目默认文件管理器按钮的静态回归
 * [POS]: tests 的详情面板信息层次合同
 * [PROTOCOL]: 变更时更新此头部，然后检查 web/CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('详情侧栏把接力、元信息和删除整体放在内容长文之前', () => {
  const source = fs.readFileSync('web/src/panels/DetailPanel.jsx', 'utf8');
  const positions = ['HANDOFF · 接力提示词', 'DETAIL · 元信息', 'DANGER · 删除', 'CONTEXT · 聊了什么', 'STOP · 最后停在哪里']
    .map(title => source.indexOf(`title="${title}"`));
  assert.ok(positions.every(position => position >= 0), 'all detail sections must exist');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('详情路径使用醒目独立按钮，所有画布入口不再把 Finder 写死', () => {
  const detail = fs.readFileSync('web/src/panels/DetailPanel.jsx', 'utf8');
  const menus = fs.readFileSync('web/src/canvas/menus.jsx', 'utf8');
  assert.match(detail, /className="btn folder-open-btn"/);
  assert.match(detail, /用电脑默认的文件管理器打开此目录/);
  assert.doesNotMatch(detail, /Finder/);
  assert.doesNotMatch(menus, /Finder/);
});
