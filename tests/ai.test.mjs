import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonOf } from '../server/ai.mjs';

test('jsonOf extracts the first complete JSON object without greedy spillover', () => {
  assert.deepEqual(jsonOf('说明 {"title":"修复 {嵌套} 文案","tags":["一"]} 尾注 {"noise":1}'), {
    title: '修复 {嵌套} 文案', tags: ['一'],
  });
});

test('jsonOf skips malformed candidates and returns null when none are valid', () => {
  assert.deepEqual(jsonOf('坏块 {oops} 后面 {"ok":true}'), { ok: true });
  assert.equal(jsonOf('完全没有 JSON'), null);
});
