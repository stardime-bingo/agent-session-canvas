import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(repo, 'scripts/serve-canvas-acceptance.mjs');
const verifier = path.join(repo, 'tests/fixtures/canvas-acceptance/verify.py');
const python = process.env.LE013_PYTHON || '/opt/homebrew/bin/python3';

const waitForReady = child => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => reject(new Error(`4518 canvas server timeout\n${stderr}`)), 90000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value.ready && value.fixture === 'canvas'
          && value.url === 'http://127.0.0.1:4518') {
          clearTimeout(timer);
          resolve(value);
        }
      } catch { /* build output is outside the ready protocol */ }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', code => {
    clearTimeout(timer);
    reject(new Error(`4518 canvas server exited ${code}\n${stderr}`));
  });
});

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: repo, env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', code => code === 0
    ? resolve({ stdout, stderr })
    : reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
});

const stop = child => new Promise(resolve => {
  if (child.exitCode != null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGTERM');
});

test('production static 4518 passes real 300/800 canvas worker and post-paint gates', { timeout: 300000 }, async t => {
  const server = spawn(process.execPath, [serverScript, '--fixture=canvas'], {
    cwd: repo,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stop(server));
  const ready = await waitForReady(server);
  assert.match(ready.dist, /agent-canvas-4518-/);

  const rootResponse = await fetch('http://127.0.0.1:4518/');
  assert.equal(rootResponse.status, 200);
  const pageCsp = rootResponse.headers.get('content-security-policy') || '';
  assert.match(pageCsp, /connect-src 'self'/);
  assert.match(pageCsp, /font-src 'self' data:/);
  assert.doesNotMatch(pageCsp, /(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)/);

  const verified = await run(python, [verifier]);
  const report = JSON.parse(verified.stdout.trim().split('\n').at(-1));
  assert.equal(report.ok, true);
  assert.deepEqual(report.sizes.map(entry => entry.size), [300, 800]);
  assert.ok(report.sizes.every(entry => entry.status === 'pass'));
  assert.ok(report.sizes.every(entry => entry.workerObserved === true));
  assert.ok(report.sizes.every(entry => entry.sampledAfterPaint === true));
  assert.ok(report.sizes.every(entry =>
    entry.consoleErrors === 0
    && entry.consoleWarnings === 0
    && entry.pageErrors === 0
    && entry.externalResources === 0
    && entry.apiResources === 0));
});
