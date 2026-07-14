import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractContextPage, extractEndingDigest, jsonOf } from '../server/ai.mjs';

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

// ============================================================
//  终端框倒序分页：首页停在最新，向上翻页行对齐、偏移严格递减、到头有旗
// ============================================================
test('extractContextPage pages backwards through the whole session without overlap or loss', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-page-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'paged.jsonl');
  const rows = Array.from({ length: 120 }, (_, i) =>
    ({ type: 'assistant', message: { content: `事件编号 ${String(i).padStart(3, '0')}` } }));
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const s = { filePath };

  // 首页：无 before 从文件尾读，必含最后一条
  const p1 = extractContextPage(s, undefined, 2048);
  assert.match(p1.text, /事件编号 119/);
  assert.equal(p1.atStart, false);

  // 向上翻到头：offset 严格递减，页间无重叠无丢行，最终 atStart
  let before = p1.prevOffset, guard = 0, all = p1.text;
  while (true) {
    assert.ok(guard++ < 100, '翻页次数异常，疑似死循环');
    const p = extractContextPage(s, before, 2048);
    assert.ok(p.prevOffset < before, 'prevOffset 必须严格递减');
    all = p.text + '\n' + all;
    if (p.atStart) { assert.equal(p.prevOffset, 0); break; }
    before = p.prevOffset;
  }
  for (const i of [0, 42, 77, 119]) {
    const hits = all.match(new RegExp(`事件编号 ${String(i).padStart(3, '0')}`, 'g')) || [];
    assert.equal(hits.length, 1, `事件 ${i} 应恰好出现一次，实际 ${hits.length}`);
  }
});

test('extractContextPage clamps oversized before and swallows partial first lines at window edge', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-page-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'edge.jsonl');
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: 'user', message: { content: '第一句' } }),
    JSON.stringify({ type: 'assistant', message: { content: '第二句' } }),
  ].join('\n') + '\n');
  const s = { filePath };

  const whole = extractContextPage(s, 10 ** 9, 65536);   // 越界 before 收编到文件尾
  assert.equal(whole.atStart, true);
  assert.match(whole.text, /第一句/);
  assert.match(whole.text, /第二句/);
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
