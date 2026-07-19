/**
 * [INPUT]: server/launcher.mjs、临时 data/cwd 与 PATH 中的假 open
 * [OUTPUT]: Claude/Codex prompt 启动命令和同一接力文本文件的隔离回归
 * [POS]: 终端拉起证伪层；不打开真实终端，不创建真实 Claude/Codex 会话
 * [PROTOCOL]: 变更时更新此头部，然后检查 server/CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LAUNCHER_URL = new URL('../server/launcher.mjs', import.meta.url).href;

test('Claude/Codex prompt 模式分别构造命令并注入同一份接力文本', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const cwd = path.join(root, 'workspace');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(cwd);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = '# 接力\n\n同一份自包含事实。';
  const code = `
    import { launch } from ${JSON.stringify(LAUNCHER_URL)};
    const prompt = ${JSON.stringify(prompt)};
    const cwd = ${JSON.stringify(cwd)};
    const claude = launch({ tool: 'claude', cwd, mode: 'prompt', prompt, sourceKey: 'source' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const codex = launch({ tool: 'codex', cwd, mode: 'prompt', prompt, sourceKey: 'source' });
    process.stdout.write(JSON.stringify({ claude, codex }));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, AGENT_CANVAS_DATA_DIR: dataDir, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', status => status === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(`launcher child ${status}: ${stderr}`)));
  });

  assert.match(result.claude.command, /^claude "\$\(cat '.+prompt-\d+\.txt'\)"$/);
  assert.match(result.codex.command, /^codex "\$\(cat '.+prompt-\d+\.txt'\)"$/);
  const promptFiles = fs.readdirSync(path.join(dataDir, 'launch')).filter(file => file.startsWith('prompt-'));
  assert.equal(promptFiles.length, 2);
  assert.deepEqual(promptFiles.map(file => fs.readFileSync(path.join(dataDir, 'launch', file), 'utf8')), [prompt, prompt]);
});
