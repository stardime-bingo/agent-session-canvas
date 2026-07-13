import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendJsonlVerified } from '../server/store.mjs';

const run = code => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
  child.once('exit', status => status === 0 ? resolve() : reject(new Error(`child exit ${status}`)));
});

test('locked JSON updates preserve concurrent process writes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'enrich.json');
  fs.writeFileSync(file, '{"count":0}');
  const storeUrl = new URL('../server/store.mjs', import.meta.url).href;
  const code = `
    import { updateJsonLocked } from ${JSON.stringify(storeUrl)};
    const file = ${JSON.stringify(file)};
    for (let i = 0; i < 20; i++) updateJsonLocked(file, { count: 0 }, d => { d.count++; });
  `;
  await Promise.all(Array.from({ length: 4 }, () => run(code)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 80);
});

test('verified JSONL append reads back the latest matching record', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-jsonl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session_index.jsonl');
  fs.writeFileSync(file, '{"id":"other","thread_name":"keep"}\n');
  const record = { id: 'target', thread_name: '新标题', updated_at: '2026-07-13T00:00:00.000Z' };
  assert.deepEqual(appendJsonlVerified(file, record), record);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)), record);
});
