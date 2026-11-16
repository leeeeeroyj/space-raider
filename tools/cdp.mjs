// Shared harness for the milestone tests: starts Vite and headless Chrome, talks CDP, records checks and page errors.
// Node built-ins only. Each test imports `session` and finishes with `done()`.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };

const KEYS = {
  ArrowRight: [39, 'ArrowRight'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
  Enter: [13, 'Enter'], Escape: [27, 'Escape'], ' ': [32, 'Space'], m: [77, 'KeyM'],
  w: [87, 'KeyW'], a: [65, 'KeyA'], s: [83, 'KeyS'], d: [68, 'KeyD'],
  z: [90, 'KeyZ'], x: [88, 'KeyX'], Shift: [16, 'ShiftLeft'], p: [80, 'KeyP'],
};

export async function until(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(step);
  }
  throw new Error('timeout');
}

/**
 * Starts the dev server on `port` (strict, so it never lands on another game's server) and Chrome on `debugPort`,
 * then opens the game at `path`. `touch` turns on touch emulation and `pointer: coarse` before the page loads; `init` is
 * a script that runs in the page before the game's own.
 */
export async function session({ project, out, port, debugPort, width = 1664, height = 992, touch = false, mobile = false, path = '/', init = '' }) {
  mkdirSync(out, { recursive: true });
  const results = [];
  const errors = [];
  // A server already on the port would be tested in place of this checkout: refuse instead.
  if (await fetch(`http://localhost:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is already in use`);
  // Own process groups, so cleanup takes the children too (npx leaves vite running if only npx is killed).
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const chrome = spawn('google-chrome', [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${out}/profile`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', detached: true });
  const cleanup = () => { for (const p of [vite, chrome]) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} } };
  process.on('exit', cleanup);

  await until(async () => (await fetch(`http://localhost:${port}/`)).ok);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  };

  const key = (type, k) => send('Input.dispatchKeyEvent', { type, key: k, code: KEYS[k][1], windowsVirtualKeyCode: KEYS[k][0], nativeVirtualKeyCode: KEYS[k][0] });
  const down = (k) => key('rawKeyDown', k);
  const up = (k) => key('keyUp', k);
  const tap = async (k, ms = 80) => { await down(k); await sleep(ms); await up(k); };

  const click = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
  };

  // Every touch event carries every finger still down: start when one is added, move when one moves or one of
  // several lifts, end only when the last one lifts.
  const fingers = new Map();
  const points = () => [...fingers].map(([fid, p]) => ({ x: p.x, y: p.y, id: fid, radiusX: 4, radiusY: 4, force: 1 }));
  const press = (fid, x, y) => { fingers.set(fid, { x, y }); return send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points() }); };
  const move = (fid, x, y) => { fingers.set(fid, { x, y }); return send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points() }); };
  const lift = (fid) => {
    fingers.delete(fid);
    return send('Input.dispatchTouchEvent', { type: fingers.size ? 'touchMove' : 'touchEnd', touchPoints: points() });
  };

  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const done = () => {
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    cleanup();
    process.exit(passed === results.length ? 0 : 1);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', mobile
    ? { width, height, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }
    : { width, height, deviceScaleFactor: 1, mobile: false });
  if (touch) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  }
  if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init });
  await send('Page.navigate', { url: `http://localhost:${port}${path}` });

  return { send, evaluate, until, shot, down, up, tap, click, press, move, lift, check, done, errors, sleep };
}
