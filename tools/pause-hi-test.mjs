// Pause and high score: P, Esc and the page going to the background pause the raid; P or Enter resumes; Esc from the
// pause menu goes to the title. A sentry's next shot waits out the pause. A run's score becomes the high score
// (space-raider-hi), shown on the title and the game-over banner, and a lower score doesn't replace it.
// Usage: node tools/pause-hi-test.mjs <project-dir> <out-dir>
import { session } from './cdp.mjs';

const [project, out] = process.argv.slice(2);
const t = await session({ project, out, port: 5247, debugPort: 9417 });
const { evaluate, until, shot, tap, check, sleep } = t;
const G = 'window.__spaceRaider';
const S = `${G}.scene.getScene('room')`;
const hud = `${G}.scene.getScene('hud')`;
const start = async () => {
  await until(() => evaluate(`${G}.scene.isActive('title')`));
  await sleep(400);
  await tap('Enter');
  await until(() => evaluate(`${G}.scene.isActive('room') && !!${G}.registry.get('hudState')`), 5000);
  await sleep(800);
};
// Something that moves every frame while the raid runs: a mine bouncing round the room.
const mine = `(() => { const s = ${S}; s.addEnemy('mine', 200, 120).setData('wakeAt', 0); })()`;
const minePos = () => evaluate(`(() => { const m = ${S}.enemies.getChildren().find((e) => e.getData('kind') === 'mine'); return m ? m.x + m.y : 0; })()`);

await until(() => evaluate(`!!${G}`));
await evaluate(`localStorage.clear()`);
await start();
await evaluate(`${S}.invulnerableUntil = ${S}.time.now + 1e6`);
await evaluate(mine);
await sleep(300);

await tap('p');
await sleep(100);
const a = await minePos();
await sleep(600);
check('P pauses: the hostiles hold still', (await evaluate(`${S}.paused`)) && (await minePos()) === a);
check('the pause panel shows', await evaluate(`${hud}.pauseMenu.visible`));
await shot('1-paused');
await tap('p');
await sleep(400);
check('P again resumes', !(await evaluate(`${S}.paused`)) && (await minePos()) !== a);
await evaluate(`${S}.nextSpawnAt = ${S}.time.now + 5000`);
await tap('Escape');
await sleep(100);
check('Esc pauses too', await evaluate(`${S}.paused`));
// Times things are due move on by the pause.
const due = await evaluate(`${S}.nextSpawnAt - ${S}.time.now`);
await sleep(1000);
await tap('Enter');
await sleep(50);
check('Enter resumes', !(await evaluate(`${S}.paused`)));
{ const left = await evaluate(`${S}.nextSpawnAt - ${S}.time.now`); check('timers wait out the pause', due > 4000 && Math.abs(left - due) < 300, `${Math.round(due)} → ${Math.round(left)} ms`); }
await evaluate(`Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(100);
check('the page going to the background pauses', await evaluate(`${S}.paused && ${S}.physics.world.isPaused`));
// Phaser's own loop sleeps on the same event: wake it.
await evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(200);
await tap('Escape');
await until(() => evaluate(`${G}.scene.isActive('title')`), 3000).catch(() => {});
check('Esc from the pause menu goes to the title', await evaluate(`${G}.scene.isActive('title') && !${G}.scene.isActive('hud')`));

await start();
check('a run started after leaving from pause is not paused, and its clocks run', !(await evaluate(`${S}.paused || ${S}.time.paused || ${S}.tweens.paused || ${S}.physics.world.isPaused`)));
const over = async (score) => {
  await evaluate(`(() => { const s = ${S}; s.score = ${score}; s.lives = 1; s.invulnerableUntil = 0; s.loseShip(); })()`);
  // Headless Chrome draws the bloom slowly, so the game clock runs well behind real time here.
  await until(() => evaluate(`${S}.over`), 15000);
  await sleep(300);
};
await over(1234);
await shot('2-new-high');
check('game over saves the high score', (await evaluate(`localStorage.getItem('space-raider-hi')`)) === '1234');
check('the banner says NEW HIGH SCORE!', await evaluate(`${S}.subBanner.text.includes('NEW HIGH SCORE!')`));
await until(() => evaluate(`${S}.time.now - ${S}.overAt > 900`), 8000);
await tap('Enter');
await until(() => evaluate(`!${S}.over`), 8000);
await sleep(500);
await over(500);
check('a lower score leaves it alone', (await evaluate(`localStorage.getItem('space-raider-hi')`)) === '1234');
{ const sub = await evaluate(`${S}.subBanner.text`); check('and the banner shows the high score', sub.includes('HI 1,234'), sub.replace(/\n/g, ' / ')); }
await until(() => evaluate(`${S}.time.now - ${S}.overAt > 900`), 8000);
await tap('Escape');
await until(() => evaluate(`${G}.scene.isActive('title')`), 5000);
await sleep(400);
await shot('3-title');
check('the title shows HI', await evaluate(`${G}.scene.getScene('title').children.list.some((o) => o.text === 'HI 1,234')`));
t.done();
