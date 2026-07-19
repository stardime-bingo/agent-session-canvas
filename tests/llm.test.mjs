/**
 * [INPUT]: server/llm.mjs 与临时 PATH 中的假 Codex/Claude CLI
 * [OUTPUT]: Codex stdout 兼容与 Claude sonnet fallback 的隔离路由回归
 * [POS]: 模型路由证伪层；不调用真实模型、不读取或写入 ~/.codex、~/.claude、仓内 data
 * [PROTOCOL]: 变更时更新此头部，然后检查 server/CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LLM_URL = new URL('../server/llm.mjs', import.meta.url).href;

function executable(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function runRoute(dataDir, binDir) {
  const code = `
    import { runLLM } from ${JSON.stringify(LLM_URL)};
    const result = await runLLM('fixture prompt');
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: {
        ...process.env,
        AGENT_CANVAS_DATA_DIR: dataDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', status => status === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(`route child ${status}: ${stderr}`)));
  });
}

test('Codex 成功但未生成 -o 文件时使用 stdout 最终文本', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-llm-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ llm: { order: ['codex'] } }));
  executable(path.join(binDir, 'codex'), "printf 'codex stdout final\\n'");

  assert.deepEqual(await runRoute(dataDir, binDir), { text: 'codex stdout final', backend: 'codex' });
});

test('Codex 失败后 Claude 使用稳定 sonnet 别名兜底', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-llm-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(binDir);
  executable(path.join(binDir, 'codex'), "printf 'codex unavailable\\n' >&2; exit 1");
  executable(path.join(binDir, 'claude'), "case \"$*\" in *'--model sonnet'*) printf 'claude fallback final\\n' ;; *) exit 42 ;; esac");

  assert.deepEqual(await runRoute(dataDir, binDir), { text: 'claude fallback final', backend: 'claude' });
});
