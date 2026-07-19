/**
 * [INPUT]: server/file-viewer.mjs 的默认文件管理器解析与执行边界
 * [OUTPUT]: 第三方默认、Finder/未配置与失效第三方回退的零桌面副作用回归
 * [POS]: tests 的文件夹打开合同；注入执行器，绝不在测试里真正拉起应用
 * [PROTOCOL]: 变更时更新此头部，然后检查 server/CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileViewerOpenArgs, normalizeFileViewer, revealInDefaultFileViewer,
} from '../server/file-viewer.mjs';

test('文件管理器偏好只接受 bundle id，Finder 交回系统 open', () => {
  assert.equal(normalizeFileViewer(' com.jinghaoshe.qspace.pro\n'), 'com.jinghaoshe.qspace.pro');
  assert.equal(normalizeFileViewer('com.apple.finder'), null);
  assert.equal(normalizeFileViewer('/Applications/QSpace Pro.app'), null);
  assert.deepEqual(fileViewerOpenArgs('/tmp/demo', 'com.example.viewer'), ['-b', 'com.example.viewer', '/tmp/demo']);
  assert.deepEqual(fileViewerOpenArgs('/tmp/demo', 'com.apple.finder'), ['/tmp/demo']);
});

test('显式第三方默认文件管理器按 bundle id 精确打开', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    return command.endsWith('/defaults') ? { stdout: 'com.jinghaoshe.qspace.pro\n' } : { stdout: '' };
  };
  const result = await revealInDefaultFileViewer('/Users/demo/project', { execute });
  assert.deepEqual(result, { ok: true, opener: 'com.jinghaoshe.qspace.pro' });
  assert.deepEqual(calls, [
    ['/usr/bin/defaults', ['read', '-g', 'NSFileViewer']],
    ['/usr/bin/open', ['-b', 'com.jinghaoshe.qspace.pro', '/Users/demo/project']],
  ]);
});

test('未配置或 Finder 默认时直接使用系统 open', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command.endsWith('/defaults')) return { stdout: 'com.apple.finder\n' };
    return { stdout: '' };
  };
  const result = await revealInDefaultFileViewer('/Users/demo/project', { execute });
  assert.deepEqual(result, { ok: true, opener: 'system' });
  assert.deepEqual(calls.at(-1), ['/usr/bin/open', ['/Users/demo/project']]);
});

test('第三方偏好已失效时回退系统 open，目录入口仍可用', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command.endsWith('/defaults')) return { stdout: 'com.example.removed\n' };
    if (args[0] === '-b') throw new Error('application not found');
    return { stdout: '' };
  };
  const result = await revealInDefaultFileViewer('/Users/demo/project', { execute });
  assert.deepEqual(result, { ok: true, opener: 'system', fallbackFrom: 'com.example.removed' });
  assert.deepEqual(calls.at(-1), ['/usr/bin/open', ['/Users/demo/project']]);
});
