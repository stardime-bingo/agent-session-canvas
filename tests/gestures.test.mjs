/**
 * [INPUT]: 依赖 node:test/assert 与 web/src/canvas/gestures.js 纯内核
 * [OUTPUT]: 滚轮双模回归：设备判定强弱信号、手势连续性、光标锚定缩放不变量、缩放钳制
 * [POS]: tests 的手势判定证伪层——鼠标滚轮必须缩放、触控板必须平移，谁也不许再吃掉谁
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wheelDevice, zoomViewport, nextWheelMode } from '../web/src/canvas/gestures.js';

const ev = o => ({ deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 0, clientY: 0, ...o });
const RECT = { left: 0, top: 0 };

test('Chrome/Safari 滚轮棘轮（wheelDelta 为 120 倍数）判为鼠标', () => {
  assert.equal(wheelDevice(ev({ deltaY: 100, wheelDeltaY: -120 })), 'mouse');
  assert.equal(wheelDevice(ev({ deltaY: 240, wheelDeltaY: -240 })), 'mouse');
});

test('Firefox 行滚动模式与大增量整数判为鼠标', () => {
  assert.equal(wheelDevice(ev({ deltaY: 3, deltaMode: 1 })), 'mouse');
  assert.equal(wheelDevice(ev({ deltaY: 120 })), 'mouse');
});

test('二维增量、亚像素增量与小整数轻扫判为触控板', () => {
  assert.equal(wheelDevice(ev({ deltaX: -4, deltaY: 2 })), 'trackpad');
  assert.equal(wheelDevice(ev({ deltaY: 3.5, wheelDeltaY: -10 })), 'trackpad');
  assert.equal(wheelDevice(ev({ deltaY: 6 })), 'trackpad');
});

test('手势连续性：150ms 内沿用上次判定，触控板惯性不许中途翻成鼠标', () => {
  const now = 1000;
  const momentum = ev({ deltaY: 40, wheelDeltaY: -120 });   // 惯性衰减恰好撞上 120 倍数
  assert.equal(wheelDevice(momentum, { device: 'trackpad', t: now - 50 }, now), 'trackpad');
  assert.equal(wheelDevice(momentum, { device: 'trackpad', t: now - 500 }, now), 'mouse');
});

test('缩放锚定光标：光标下的画布点缩放前后钉在原地', () => {
  const vp = { x: 100, y: 50, zoom: 1 };
  const out = zoomViewport(vp, ev({ deltaY: -120, clientX: 400, clientY: 300 }), RECT);
  assert.ok(out.zoom > vp.zoom);
  const before = { x: (400 - vp.x) / vp.zoom, y: (300 - vp.y) / vp.zoom };
  const after = { x: (400 - out.x) / out.zoom, y: (300 - out.y) / out.zoom };
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test('缩放钳制 min/max：到界后视口原样返回，不再漂移', () => {
  const top = { x: 7, y: 9, zoom: 1.8 };
  assert.deepEqual(zoomViewport(top, ev({ deltaY: -120, clientX: 100, clientY: 100 }), RECT), top);
  const floor = zoomViewport({ x: 0, y: 0, zoom: 0.12 }, ev({ deltaY: 900, clientX: 0, clientY: 0 }), RECT);
  assert.equal(floor.zoom, 0.1);
});

test('滚轮模式循环 auto→trackpad→mouse→auto', () => {
  assert.equal(nextWheelMode('auto'), 'trackpad');
  assert.equal(nextWheelMode('trackpad'), 'mouse');
  assert.equal(nextWheelMode('mouse'), 'auto');
});
