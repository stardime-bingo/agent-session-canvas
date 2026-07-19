import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffEdges } from '../server/scanner.mjs';

const cwd = '/fixture/handoff-cross-tool';
const sourceKey = 'claude:source-session';
const sessions = [
  { key: sourceKey, tool: 'claude', cwd, createdAt: '2026-07-19T00:00:00.000Z' },
  { key: 'claude:same-tool-child', tool: 'claude', cwd, createdAt: '2026-07-19T00:01:00.000Z' },
  { key: 'codex:target-child', tool: 'codex', cwd, createdAt: '2026-07-19T00:02:00.000Z' },
];

test('跨工具接力按 lineage 目标 tool 连边，而不是沿用来源 tool', () => {
  assert.deepEqual(handoffEdges([{
    sourceKey,
    tool: 'codex',
    cwd,
    ts: '2026-07-19T00:00:30.000Z',
  }], sessions), [{ from: sourceKey, to: 'codex:target-child', type: 'handoff' }]);
});

test('没有 tool 的历史 lineage 继续按来源工具匹配', () => {
  assert.deepEqual(handoffEdges([{
    sourceKey,
    cwd,
    ts: '2026-07-19T00:00:30.000Z',
  }], sessions), [{ from: sourceKey, to: 'claude:same-tool-child', type: 'handoff' }]);
});
