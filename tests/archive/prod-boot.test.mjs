import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(repo, 'scripts/serve-canvas-acceptance.mjs');
const verifier = path.join(repo, 'tests/fixtures/canvas-acceptance/verify.py');
const python = process.env.LE014_PYTHON || '/opt/homebrew/bin/python3';

const waitForReady = child => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => reject(new Error(`4518 prod server timeout\n${stderr}`)), 90000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value.ready && value.fixture === 'prod'
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
    reject(new Error(`4518 prod server exited ${code}\n${stderr}`));
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

test('strict 4518 boots the real production app and independently passes all seven interaction chains', { timeout: 300000 }, async t => {
  const server = spawn(process.execPath, [serverScript, '--fixture=prod'], {
    cwd: repo,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stop(server));
  const ready = await waitForReady(server);
  assert.match(ready.dist, /agent-prod-4518-/);

  for (const pathname of ['/api/graph', '/data/canvas.json', '/@fs/private', '/.git/config']) {
    const response = await fetch(`http://127.0.0.1:4518${pathname}`);
    assert.equal(response.status, 403, pathname);
  }
  const response = await fetch('http://127.0.0.1:4518/');
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy') || '';
  const scriptSrc = csp.split(';').map(value => value.trim())
    .find(value => value.startsWith('script-src ')) || '';
  assert.match(scriptSrc, /'sha256-\+ZhgVBfEh3qSkRtu4\+LWwD2KtClSz7NQW2e602MUclw='/);
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
  assert.doesNotMatch(scriptSrc, /(?:^|\s)'unsafe-eval'(?:\s|$)/);

  const workerEntries = fs.readdirSync(path.join(ready.dist, 'assets'))
    .filter(file => file.endsWith('.js') && file.includes('subset-worker'))
    .filter(file => /self\.onmessage/.test(fs.readFileSync(path.join(ready.dist, 'assets', file), 'utf8')));
  assert.deepEqual(new Set(workerEntries.map(file => `assets/${file}`)), new Set([
    ...ready.workers.prod,
    ...ready.workers.interaction,
  ]));
  for (const [entry, suffix] of [
    [ready.workers.prod[0], ''],
    [ready.workers.interaction[0], '?mode=interaction'],
  ]) {
    const workerResponse = await fetch(`http://127.0.0.1:4518/${entry}${suffix}`);
    assert.equal(workerResponse.status, 200);
    const workerCsp = workerResponse.headers.get('content-security-policy') || '';
    assert.match(workerCsp, /'unsafe-eval'/);
    assert.match(workerCsp, /'wasm-unsafe-eval'/);
  }

  const verified = await run(python, [verifier, '--suite=prod']);
  const report = JSON.parse(verified.stdout.trim().split('\n').at(-1));
  assert.equal(report.ok, true);
  assert.equal(report.suite, 'prod');
  assert.equal(report.production.status, 'pass');
  assert.equal(report.production.graphCalls, 1);
  assert.deepEqual(report.production.eventSource, { created: 1, opened: 1, closed: 0 });
  assert.deepEqual(report.production.eventSourceUrls, ['/api/events']);
  assert.equal(report.interaction.status, 'pass');
  assert.deepEqual(report.interaction.checks, {
    concurrent: true,
    revision: true,
    opening: true,
    closing: true,
    coldError: true,
    warmError: true,
    lateIsolation: true,
  });
  const closing = report.interaction.closing;
  assert.equal(closing.persistedSignatureChanged, true);
  assert.equal(closing.drawingCommitDelta, 1);
  if (closing.reusedWithoutExport) {
    assert.equal(closing.export, null);
    assert.equal(closing.exactSeedReuse, true);
    assert.equal(closing.seedExport.scenario, 'closing');
    assert.equal(closing.seedExport.kind, 'group');
    assert.ok(closing.seedExport.revision > closing.fromRevision);
    assert.ok(closing.seedExport.revision < closing.revision);
    assert.deepEqual(closing.seedExport.signature, closing.finalDrawingSignature);
  }
  for (const section of [report.production, report.interaction]) {
    assert.equal(section.consoleErrors, 0);
    assert.equal(section.consoleWarnings, 0);
    assert.equal(section.pageErrors, 0);
    assert.equal(section.requestFailed, 0);
    assert.equal(section.externalResources, 0);
    assert.equal(section.apiResources, 0);
  }
});
