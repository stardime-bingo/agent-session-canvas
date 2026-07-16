import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(repo, 'scripts/serve-canvas-acceptance.mjs');
const verifier = path.join(repo, 'tests/fixtures/carry-acceptance/verify.py');
const python = process.env.LE011_PYTHON || '/opt/homebrew/bin/python3';

const waitForReady = child => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => reject(new Error(`4518 static server timeout\n${stderr}`)), 90000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value.ready && value.url === 'http://127.0.0.1:4518') {
          clearTimeout(timer);
          resolve(value);
        }
      } catch { /* Vite build output is not part of the ready protocol */ }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', code => {
    clearTimeout(timer);
    reject(new Error(`4518 static server exited ${code}\n${stderr}`));
  });
});

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: repo, env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
});

test('production static 4518 runs direct carry plus real React batch arrange/undo handoffs', { timeout: 300000 }, async t => {
  const server = spawn(process.execPath, [serverScript], {
    cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (server.exitCode == null) server.kill('SIGTERM');
  });
  const ready = await waitForReady(server);
  assert.match(ready.dist, /agent-carry-4518-/);

  const apiResponse = await fetch('http://127.0.0.1:4518/api/graph');
  assert.equal(apiResponse.status, 403);
  const rootResponse = await fetch('http://127.0.0.1:4518/');
  assert.equal(rootResponse.status, 200);
  assert.equal(rootResponse.headers.get('content-security-policy'), "script-src 'self'; object-src 'none'; base-uri 'none'");
  const html = await rootResponse.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)|<style\b|react-refresh|\/@fs|@vite\/client/i);

  const verified = await run(python, [verifier]);
  console.log(verified.stdout.trim());
  const report = JSON.parse(verified.stdout.trim().split('\n').at(-1));
  assert.equal(report.ok, true);
  assert.equal(report.productionIntegration, true);
  assert.deepEqual(report.scenarios.map(entry => entry.scenario), [
    'normal', 'response-unknown', 'export-retry', 'no-anchor',
    'authority-conflict-800', 'escape', 'pointercancel',
  ]);
  assert.ok(report.scenarios.every(entry => entry.samples >= 60));
  assert.ok(report.scenarios.every(entry => entry.distinctMoveSamples >= 60));
  assert.ok(report.scenarios.every(entry => entry.moveHandlerCount >= 60));
  assert.ok(report.scenarios.every(entry => entry.maxUnrelatedMove <= 0.1));
  assert.ok(report.scenarios.filter(entry => entry.phaseErrorApplicable)
    .every(entry => entry.maxRelativeError <= 0.5 && entry.maxMiniError <= 0.5));
  const stress = report.scenarios.find(entry => entry.scenario === 'authority-conflict-800');
  assert.ok(stress.moveHandlerP95 < 4 && stress.longTaskCount === 0);
  assert.ok(report.scenarios.every(entry => entry.trace.byteLength > 0 && /^[0-9a-f]{64}$/.test(entry.trace.sha256)));
  assert.deepEqual(report.batchScenarios.map(entry => entry.scenario), [
    'batch-normal', 'batch-export-retry', 'batch-response-unknown',
  ]);
  assert.ok(report.batchScenarios.every(entry => entry.samples >= 20));
  assert.ok(report.batchScenarios.every(entry =>
    entry.arrangeGeneration !== entry.undoGeneration
    && entry.maxBoardRelativeError <= 0.5
    && entry.maxDistrictRelativeError <= 0.5));
  assert.equal(report.batchScenarios.find(entry => entry.scenario === 'batch-export-retry').exportFailures, 3);
  assert.equal(report.batchScenarios.find(entry => entry.scenario === 'batch-response-unknown').statusQueries, 1);
  assert.ok(report.batchScenarios.every(entry =>
    entry.trace.byteLength > 0 && /^[0-9a-f]{64}$/.test(entry.trace.sha256)));
  assert.match(report.browserVersion, /Chrome|Chromium|\d/);
  assert.ok(report.scenarios.every(entry => entry.productionIntegration));
  assert.ok(report.batchScenarios.every(entry => entry.productionIntegration));
});
