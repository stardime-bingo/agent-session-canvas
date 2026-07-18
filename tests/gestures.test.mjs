/**
 * [INPUT]: web/src/canvas/gestures.js 纯内核
 * [OUTPUT]: 设备判定连续性、光标锚定缩放、armed wheel 单相机与三态偏好回归
 * [POS]: tests 的导航手势证伪层——鼠标/触控板都只改 RF 相机
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextWheelMode, wheelDevice, wheelViewport, zoomViewport } from '../web/src/canvas/gestures.js';

const event = input => ({ deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 0, clientY: 0, ...input });
const RECT = { left: 0, top: 0 };

test('浏览器滚轮棘轮与行模式判为鼠标', () => {
  assert.equal(wheelDevice(event({ deltaY: 100, wheelDeltaY: -120 })), 'mouse');
  assert.equal(wheelDevice(event({ deltaY: 3, deltaMode: 1 })), 'mouse');
  assert.equal(wheelDevice(event({ deltaY: 120 })), 'mouse');
});

test('二维/亚像素/小整数增量判为触控板', () => {
  assert.equal(wheelDevice(event({ deltaX: -4, deltaY: 2 })), 'trackpad');
  assert.equal(wheelDevice(event({ deltaY: 3.5, wheelDeltaY: -10 })), 'trackpad');
  assert.equal(wheelDevice(event({ deltaY: 6 })), 'trackpad');
});

test('150ms 手势连续性不让触控板惯性中途翻成鼠标', () => {
  const now = 1000;
  const momentum = event({ deltaY: 40, wheelDeltaY: -120 });
  assert.equal(wheelDevice(momentum, { device: 'trackpad', t: now - 50 }, now), 'trackpad');
  assert.equal(wheelDevice(momentum, { device: 'trackpad', t: now - 500 }, now), 'mouse');
});

test('鼠标缩放锚住光标下的世界点', () => {
  const viewport = { x: 100, y: 50, zoom: 1 };
  const out = zoomViewport(viewport, event({ deltaY: -120, clientX: 400, clientY: 300 }), RECT);
  const before = { x: (400 - viewport.x) / viewport.zoom, y: (300 - viewport.y) / viewport.zoom };
  const after = { x: (400 - out.x) / out.zoom, y: (300 - out.y) / out.zoom };
  assert.ok(out.zoom > viewport.zoom);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test('缩放到 min/max 后原样返回、不漂移', () => {
  const top = { x: 7, y: 9, zoom: 1.8 };
  assert.equal(zoomViewport(top, event({ deltaY: -120, clientX: 100, clientY: 100 }), RECT), top);
  const floor = zoomViewport({ x: 0, y: 0, zoom: 0.12 }, event({ deltaY: 900 }), RECT);
  assert.equal(floor.zoom, 0.1);
});

test('armed wheel：触控板平移、Shift 横移、鼠标与捏合缩放', () => {
  const viewport = { x: 10, y: 20, zoom: 1 };
  assert.deepEqual(wheelViewport(viewport, event({ deltaX: 4, deltaY: 6 }), RECT, { mode: 'trackpad' }).viewport,
    { x: 6, y: 14, zoom: 1 });
  assert.deepEqual(wheelViewport(viewport, event({ deltaY: 8, shiftKey: true }), RECT, { mode: 'trackpad' }).viewport,
    { x: 2, y: 20, zoom: 1 });
  assert.equal(wheelViewport(viewport, event({ deltaY: -40, ctrlKey: true }), RECT).kind, 'zoom');
  assert.equal(wheelViewport(viewport, event({ deltaY: -120 }), RECT, { mode: 'mouse' }).kind, 'zoom');
});

test('滚轮模式循环 auto→trackpad→mouse→auto', () => {
  assert.equal(nextWheelMode('auto'), 'trackpad');
  assert.equal(nextWheelMode('trackpad'), 'mouse');
  assert.equal(nextWheelMode('mouse'), 'auto');
});
