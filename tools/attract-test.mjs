// Attract mode check (Arcadia's "Done when" list): `/?attract` shows gameplay within 2 s with no title or prompts,
// demos end and restart by themselves, no sound is asked for and no AudioContext is made, keys / mouse / a gamepad
// change nothing, localStorage is untouched, the heap stays flat, no page errors, and the game fits a small iframe.
// Usage: node tools/attract-test.mjs <project-dir> <out-dir>
import { session } from './cdp.mjs';

// ---- What differs per game ----
const G = 'window.__spaceRaider';
const S = `${G}.scene.getScene('room')`;
const GAME = {
  port: 5246, debugPort: 9416,
  /** Gameplay is up: a room runs and the title doesn't. */
  playing: `${G}.scene.isActive('room') && !${G}.scene.isActive('title') && !!${G}.registry.get('hudState')`,
  /** Demos started so far. */
  demos: `${S}.constructor.demos`,
  /** The ship's position. */
  pos: `[${S}.player.x, ${S}.player.y]`,
  /** The core verb near a threat: the beam on a hostile. */
  verb: `!!${S}.flashed && ${S}.flashed.active`,
  /** Sounds made (none can be without an audio context). */
  played: `${G}.sound.sounds.length`,
  /** Anything a player's input would change. */
  state: `({ paused: ${S}.paused, title: ${G}.scene.isActive('title') })`,
  /** The longest the ship may sit still (being destroyed and coming back counts), s. */
  stillMax: 2.5,
};
// ---- The rest is the same in every game ----

const [project, out] = process.argv.slice(2);
// Spies, before the game loads: AudioContext construction, gamepad polling (with a pad that can be "pressed"), and
// every storage write. Two keys go in first so "unchanged" means something.
const init = `(() => {
  if (!localStorage.getItem('attract-probe')) { localStorage.setItem('attract-probe', '1'); localStorage.setItem('arcadia-probe', 'x'); }
  window.__spy = { audio: 0, pads: 0, writes: 0, padOn: false };
  for (const k of ['AudioContext', 'webkitAudioContext']) {
    const C = window[k]; if (!C) continue;
    window[k] = new Proxy(C, { construct(t, a) { window.__spy.audio++; return Reflect.construct(t, a); } });
  }
  const pad = () => ({ id: 'fake pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: window.__spy.padOn, touched: window.__spy.padOn, value: window.__spy.padOn ? 1 : 0 })) });
  navigator.getGamepads = () => { window.__spy.pads++; return [pad(), null, null, null]; };
  for (const m of ['setItem', 'removeItem', 'clear']) {
    const f = Storage.prototype[m];
    Storage.prototype[m] = function (...a) { window.__spy.writes++; return f.apply(this, a); };
  }
})();`;
const t = await session({ project, out, port: GAME.port, debugPort: GAME.debugPort, width: 832, height: 456, path: '/?attract&seed=7', init });
const { send, evaluate, until, shot, tap, click, check, sleep } = t;
const t0 = Date.now();
const since = () => (Date.now() - t0) / 1000;

const storage = () => evaluate(`JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))`);
const heap = async () => { await send('HeapProfiler.collectGarbage'); return (await send('Runtime.getHeapUsage')).result.usedSize; };

// 1. Straight into play.
await until(() => evaluate(GAME.playing), 4000, 50).catch(() => {});
const upAt = since();
await sleep(Math.max(0, 2000 - (Date.now() - t0)));
await shot('attract-1-2s');
check('gameplay on screen within 2 s, no title or menu', (await evaluate(GAME.playing)) && upAt <= 2, `up at ${upAt.toFixed(1)} s`);
const storeBefore = await storage();

// Then 60 s of watching, sampling the player.
const demos0 = await evaluate(GAME.demos);
let last = null, stillFor = 0, worstStill = 0, verbAt = null, heap10 = 0, inputsAt = 0, before = null, after = null;
while (since() < 64) {
  const s = since();
  const p = await evaluate(GAME.pos).catch(() => null);
  if (p && last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.5) stillFor += 0.25; else stillFor = 0;
  worstStill = Math.max(worstStill, stillFor);
  last = p;
  if (verbAt === null && (await evaluate(GAME.verb).catch(() => false))) verbAt = s;
  if (!heap10 && s >= 10) heap10 = await heap();
  if (!inputsAt && s >= 20) {
    // 4. Keys, a click and a gamepad, all while the demo runs.
    inputsAt = s;
    before = await evaluate(GAME.state);
    for (const k of ['Enter', ' ', 'p', 'Escape', 'ArrowUp', 'z', 'm']) await tap(k, 40);
    await click(416, 228);
    await evaluate(`window.__spy.padOn = true`);
    await sleep(800);
    await evaluate(`window.__spy.padOn = false`);
    await sleep(300);
    after = await evaluate(GAME.state);
    await shot('attract-2-after-input');
  }
  await sleep(250);
}
const heap60 = await heap();
await shot('attract-3-60s');
const demos1 = await evaluate(GAME.demos);
const spy = await evaluate(`window.__spy`);

check('the core verb near a threat within 5 s', verbAt !== null && verbAt <= 5, verbAt === null ? 'never' : `at ${verbAt.toFixed(1)} s`);
check(`never stands still for more than ${GAME.stillMax} s`, worstStill <= GAME.stillMax, `longest ${worstStill.toFixed(2)} s`);
check('2. a demo ended and a new one started, with no input', demos1 > demos0, `demos ${demos0} → ${demos1}`);
check('3. no sound asked for', (await evaluate(GAME.played)) === 0);
check('3. no AudioContext made', spy.audio === 0, `${spy.audio} made`);
check('4. keys, a click and a gamepad change nothing', JSON.stringify(before) === JSON.stringify(after) && (await evaluate(GAME.playing)), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
check('4. the gamepad is never even read', spy.pads === 0, `${spy.pads} polls`);
check('4. focus never leaves the page body', await evaluate(`document.activeElement === document.body`));
check('5. localStorage identical, and nothing written', (await storage()) === storeBefore && spy.writes === 0, `${spy.writes} writes`);
const growth = (heap60 - heap10) / heap10;
check('6. heap at 60 s within 10 % of 10 s', growth <= 0.1, `${(heap10 / 1e6).toFixed(1)} → ${(heap60 / 1e6).toFixed(1)} MB (${(growth * 100).toFixed(1)} %)`);

// 7. Any size: the whole game area inside the frame, filling one side.
for (const [w, h] of [[320, 176], [832, 456]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await shot(`attract-4-${w}x${h}`);
  const r = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
  const inside = r[0] >= -0.5 && r[1] >= -0.5 && r[2] <= w + 0.5 && r[3] <= h + 0.5;
  const fills = Math.abs(r[2] - r[0] - w) < 1.5 || Math.abs(r[3] - r[1] - h) < 1.5;
  check(`7. the full game area at ${w} × ${h}`, inside && fills, r.map((v) => v.toFixed(0)).join(','));
}
t.done();
