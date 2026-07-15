/**
 * [INPUT]: 依赖 node:test/assert 与 web/src/canvas/gestures.js 纯内核
 * [OUTPUT]: 编辑态 wheel/key/Safari gesture 路由、设备判定、平移/缩放数学、锚定不变量与 pointer 监听回收回归
 * [POS]: tests 的导航手势证伪层——所有画布导航必须只改 RF 相机，Excal 旁路与 window 监听残留必须为零
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPointerListenerResource, drawingGestureCapture, drawingGestureRoute, drawingWheelRoute, drawingZoomKeyRoute,
  panViewport, scaleViewport, wheelDevice, wheelViewport, zoomViewport, nextWheelMode,
} from '../web/src/canvas/gestures.js';

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

test('编辑态导航数学：pointer/触控板逐增量平移，Shift 滚轮只横移', () => {
  const vp = { x: 10, y: 20, zoom: 1 };
  assert.deepEqual(panViewport(vp, 7, -3), { x: 17, y: 17, zoom: 1 });
  assert.deepEqual(
    wheelViewport(vp, ev({ deltaX: 4, deltaY: 6 }), RECT, { mode: 'trackpad' }).viewport,
    { x: 6, y: 14, zoom: 1 },
  );
  assert.deepEqual(
    wheelViewport(vp, ev({ deltaY: 8, shiftKey: true }), RECT, { mode: 'trackpad' }).viewport,
    { x: 2, y: 20, zoom: 1 },
  );
});

test('编辑态捏合与鼠标滚轮统一光标锚定，锚点前后不漂', () => {
  const vp = { x: 100, y: 50, zoom: 1 };
  for (const input of [
    ev({ deltaY: -40, clientX: 400, clientY: 300, ctrlKey: true }),
    ev({ deltaY: -120, clientX: 400, clientY: 300, wheelDeltaY: 120 }),
  ]) {
    const out = wheelViewport(vp, input, RECT, { mode: input.ctrlKey ? 'trackpad' : 'mouse' }).viewport;
    const before = { x: (400 - vp.x) / vp.zoom, y: (300 - vp.y) / vp.zoom };
    const after = { x: (400 - out.x) / out.zoom, y: (300 - out.y) / out.zoom };
    assert.ok(Math.abs(before.x - after.x) < 1e-9);
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  }
});

test('编辑态 wheel 三路：外部功能件放行，Excal UI 只断传播，canvas 进 RF 相机', () => {
  assert.equal(drawingWheelRoute({ active: true, externalExcluded: true }), 'pass');
  assert.equal(drawingWheelRoute({ active: true, excalUi: true }), 'block');
  assert.equal(drawingWheelRoute({ active: true, externalExcluded: true, excalUi: true }), 'block');
  assert.equal(drawingWheelRoute({ active: true }), 'camera');
  assert.equal(drawingWheelRoute({ active: false, excalUi: true }), 'pass');
});

test('编辑态缩放快捷键完整复刻 Excal keyTest，文字 Shift 组合只断传播不吞字符', () => {
  const cameraKeys = [
    { code: 'Equal', shiftKey: true }, { code: 'NumpadAdd', metaKey: true },
    { code: 'Minus', shiftKey: true }, { code: 'NumpadSubtract', ctrlKey: true },
    { code: 'Digit0', shiftKey: true }, { code: 'Numpad0', metaKey: true },
    { code: 'Digit1', shiftKey: true }, { code: 'Digit2', shiftKey: true },
    { code: 'Digit3', shiftKey: true },
  ];
  for (const input of cameraKeys) {
    assert.equal(drawingZoomKeyRoute({ ...input, editable: false }), 'block');
    assert.equal(
      drawingZoomKeyRoute({ ...input, editable: true }),
      input.metaKey || input.ctrlKey ? 'block' : 'stop',
    );
  }
  assert.equal(drawingZoomKeyRoute({ code: 'Digit1', shiftKey: true, altKey: true }), 'pass');
  assert.equal(drawingZoomKeyRoute({ code: 'Digit2', shiftKey: true, metaKey: true }), 'pass');
  assert.equal(drawingZoomKeyRoute({ code: 'Digit3', shiftKey: true, ctrlKey: true }), 'pass');
  assert.equal(drawingZoomKeyRoute({ code: 'KeyA', key: 'a', editable: true, metaKey: true }), 'pass');
});

test('Safari gesture 路由：未挂载放行，opening/exiting 封门，只有稳定绘图面进 RF 相机', () => {
  assert.equal(drawingGestureRoute({ mounted: false }), 'pass');
  assert.equal(drawingGestureRoute({ mounted: true, insideRoot: true, opening: true }), 'block');
  assert.equal(drawingGestureRoute({ mounted: true, insideRoot: true, exiting: true }), 'block');
  assert.equal(drawingGestureRoute({ mounted: true, insideRoot: true, externalExcluded: true }), 'block');
  assert.equal(drawingGestureRoute({ mounted: true, insideRoot: true, excalUi: true }), 'block');
  assert.equal(drawingGestureRoute({ mounted: true, insideRoot: false }), 'block');
  assert.equal(drawingGestureRoute({ mounted: true, insideRoot: true }), 'camera');
});

test('document capture 传播模型：sibling 只封门，canvas 只写 RF，两路 Excal bubble 均为零', () => {
  const drive = insideRoot => {
    const event = {
      scale: 1.2, prevented: 0, stopped: 0,
      preventDefault() { this.prevented++; },
      stopPropagation() { this.stopped++; },
    };
    const route = drawingGestureRoute({ mounted: true, insideRoot });
    const captured = drawingGestureCapture(event, { route, phase: 'change', lastScale: 1 });
    const rfCalls = captured.camera ? 1 : 0;
    const excalCalls = event.stopped ? 0 : 1;
    return { prevented: event.prevented, stopped: event.stopped, rfCalls, excalCalls };
  };
  assert.deepEqual(drive(false), { prevented: 1, stopped: 1, rfCalls: 0, excalCalls: 0 });
  assert.deepEqual(drive(true), { prevented: 1, stopped: 1, rfCalls: 1, excalCalls: 0 });
});

test('Safari gesture 只走 RF：scale 增量锚定，UI/camera 均 prevent+stop', () => {
  const vp = { x: 100, y: 50, zoom: 1 };
  const first = scaleViewport(vp, 1.2, { clientX: 400, clientY: 300 }, RECT);
  const second = scaleViewport(first, 1.5 / 1.2, { clientX: 400, clientY: 300 }, RECT);
  assert.ok(Math.abs(second.zoom - 1.5) < 1e-9);
  const before = { x: (400 - vp.x) / vp.zoom, y: (300 - vp.y) / vp.zoom };
  const after = { x: (400 - second.x) / second.zoom, y: (300 - second.y) / second.zoom };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);

  const stub = scale => ({
    scale, clientX: 400, clientY: 300, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; },
    stopPropagation() { this.stopped++; },
  });
  const ui = stub(1.1);
  assert.deepEqual(drawingGestureCapture(ui, { route: 'block', phase: 'change', lastScale: 1 }), {
    camera: false, scaleDelta: 1, nextScale: 1,
  });
  assert.deepEqual([ui.prevented, ui.stopped], [1, 1]);
  const canvas = stub(1.25);
  assert.deepEqual(drawingGestureCapture(canvas, { route: 'camera', phase: 'change', lastScale: 1 }), {
    camera: true, scaleDelta: 1.25, nextScale: 1.25,
  });
  assert.deepEqual([canvas.prevented, canvas.stopped], [1, 1]);
});

test('pointer window 资源 cleanup 幂等，finish/卸载后四类监听零残留', () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const resource = createPointerListenerResource(target, { onMove() {}, onFinish() {} });
  resource.attach();
  resource.attach();
  assert.deepEqual([...listeners.keys()].sort(), ['blur', 'pointercancel', 'pointermove', 'pointerup']);
  assert.equal(resource.cleanup(), true);
  assert.equal(resource.cleanup(), false);
  assert.equal(listeners.size, 0);
  resource.attach();
  resource.cleanup();   // 模拟组件 unmount
  assert.equal(listeners.size, 0);
});

test('滚轮模式循环 auto→trackpad→mouse→auto', () => {
  assert.equal(nextWheelMode('auto'), 'trackpad');
  assert.equal(nextWheelMode('trackpad'), 'mouse');
  assert.equal(nextWheelMode('mouse'), 'auto');
});
