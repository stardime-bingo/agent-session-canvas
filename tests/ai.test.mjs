import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractEndingDigest, jsonOf } from '../server/ai.mjs';

test('jsonOf extracts the first complete JSON object without greedy spillover', () => {
  assert.deepEqual(jsonOf('说明 {"title":"修复 {嵌套} 文案","tags":["一"]} 尾注 {"noise":1}'), {
    title: '修复 {嵌套} 文案', tags: ['一'],
  });
});

test('jsonOf skips malformed candidates and returns null when none are valid', () => {
  assert.deepEqual(jsonOf('坏块 {oops} 后面 {"ok":true}'), { ok: true });
  assert.equal(jsonOf('完全没有 JSON'), null);
});

test('extractEndingDigest keeps the real final events instead of the opening prompt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-ending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'synthetic.jsonl');
  const rows = [
    { type: 'user', message: { content: '这是开头提示词' } },
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'assistant', message: { content: `中间行动 ${i}` } })),
    { type: 'user', message: { content: '最后一个待办是什么？' } },
    { type: 'assistant', message: { content: '停在发布前的隐私复核。' } },
  ];
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

  const ending = extractEndingDigest({ filePath });
  assert.match(ending, /最后一个待办是什么/);
  assert.match(ending, /停在发布前的隐私复核/);
  assert.doesNotMatch(ending, /这是开头提示词/);
});

test('extractEndingDigest includes current Codex custom tool calls and tail errors', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-codex-ending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'synthetic-codex.jsonl');
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查发布前状态' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'privacy_scan', input: '{"scope":"tracked files"}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'Error: synthetic secret marker found' } },
  ];
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

  const ending = extractEndingDigest({ filePath });
  assert.match(ending, /privacy_scan/);
  assert.match(ending, /synthetic secret marker found/);
});
