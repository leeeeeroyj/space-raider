import Phaser from 'phaser';
import { HEIGHT, RENDER_SCALE, WIDTH } from './config';
import { HudScene } from './scenes/HudScene';
import { RoomScene } from './scenes/RoomScene';
import { TitleScene } from './scenes/TitleScene';

async function start() {
  // Phaser bakes text into textures when it's created, so the pixel font must be ready first.
  await Promise.race([document.fonts.load('8px Silkscreen'), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => {});

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: WIDTH * RENDER_SCALE,
    height: HEIGHT * RENDER_SCALE,
    backgroundColor: '#05060d',
    pixelArt: true,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    physics: { default: 'arcade', arcade: { debug: false } },
    // Two touch pointers: one per thumb.
    input: { gamepad: true, activePointers: 2 },
    scene: [TitleScene, RoomScene, HudScene],
  });
  // Dev-only handle for poking at the running game from the console or a test script.
  if (import.meta.env.DEV) Object.assign(window, { __spaceRaider: game });
}

void start();
