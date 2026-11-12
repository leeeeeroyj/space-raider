import Phaser from 'phaser';
import { AIM_MODE_SELECTABLE, FONT, HEIGHT, RENDER_SCALE, SNAP8, SPRITES, TEXT, WIDTH } from '../config';
import { Controls } from '../controls';
import { addTreasureGlow, startSparkles } from '../fx';
import { playSound, registerSounds, restoreMute, toggleMute } from '../sfx';
import { fitCamera } from '../view';

type Star = { x: number; y: number; speed: number; alpha: number };
const MENU: ReadonlyArray<'start' | 'aim'> = AIM_MODE_SELECTABLE ? ['start', 'aim'] : ['start'];
const LOOT = ['t1_coin', 't2_chip', 't3_star', 't4_crystal', 't5_idol'] as const;
const HOSTILES = ['hunter', 'sentry', 'mine', 'warden', 'brood', 'scavenger'] as const;

export class TitleScene extends Phaser.Scene {
  private controls!: Controls;
  private selected = 0;
  private menu: Phaser.GameObjects.Text[] = [];
  private stars: Star[] = [];
  private starfield!: Phaser.GameObjects.Graphics;
  private padStatus!: Phaser.GameObjects.Text;
  private leaving = false;

  constructor() {
    super('title');
  }

  preload() {
    for (const key of SPRITES) this.load.image(key, `sprites/${key}.png`);
  }

  create() {
    if (!this.registry.has(SNAP8)) this.registry.set(SNAP8, false);
    this.selected = 0;
    this.leaving = false;
    this.controls = new Controls(this);
    fitCamera(this, RENDER_SCALE);
    registerSounds(this);
    restoreMute(this);
    this.input.setDefaultCursor('default');
    this.cameras.main.fadeIn(250);

    this.stars = Array.from({ length: 70 }, () => ({
      x: Math.random() * WIDTH, y: Math.random() * HEIGHT, speed: 3 + Math.random() * 14, alpha: 0.25 + Math.random() * 0.6,
    }));
    this.starfield = this.add.graphics();

    const cx = WIDTH / 2;
    const text = (x: number, y: number, str: string, size: number, color: string) =>
      this.add.text(x, y, str, { fontFamily: FONT, fontSize: `${size}px`, color, align: 'center' }).setOrigin(0.5, 0);

    text(cx, 10, 'A VAULT RAID IN 36 ROOMS', 8, TEXT.dim);
    text(cx, 20, 'SPACE RAIDER', 24, TEXT.amber);
    text(cx, 48, 'BLAST THE HOSTILES. GRAB WHAT GLOWS. GET OUT ALIVE.', 8, TEXT.ink);

    // Legend: what you fly, what to collect, what to shoot.
    text(64, 64, 'YOU', 8, TEXT.dim);
    this.add.image(64, 86, 'player');
    text(196, 64, 'LOOT  500 TO 8,000', 8, TEXT.dim);
    const loot = LOOT.map((key, i) => addTreasureGlow(this, this.add.image(156 + i * 20, 86, key)));
    startSparkles(this, () => loot);
    text(340, 64, 'HOSTILES', 8, TEXT.danger);
    HOSTILES.forEach((key, i) => this.add.image(340 + (i - 2.5) * 18, 86, key).setAlpha(key === 'scavenger' ? 0.7 : 1));

    this.menu = MENU.map((_, i) => {
      const item = text(cx, 106 + i * 18 + (MENU.length === 1 ? 9 : 0), '', 16, TEXT.dim).setInteractive();
      item.on('pointerover', () => (this.selected = i));
      item.on('pointerdown', () => this.activate(i));
      return item;
    });
    text(cx, 146, AIM_MODE_SELECTABLE ? 'UP / DOWN CHOOSE  ·  ENTER / A SELECT  ·  LEFT / RIGHT CHANGE AIM' : 'PRESS ENTER OR A, OR CLICK START', 8, TEXT.dim);

    const column = (x: number, title: string, keys: string, actions: string) => {
      text(x, 162, title, 8, TEXT.amber);
      this.add.text(x - 4, 174, keys, { fontFamily: FONT, fontSize: '8px', color: TEXT.ink, align: 'right', lineSpacing: 2 }).setOrigin(1, 0);
      this.add.text(x + 4, 174, actions, { fontFamily: FONT, fontSize: '8px', color: TEXT.dim, lineSpacing: 2 });
    };
    const aimLine = (key: string) => (AIM_MODE_SELECTABLE ? `\n${key}` : '');
    const aimAction = AIM_MODE_SELECTABLE ? '\nAIM MODE' : '';
    column(112, 'KEYBOARD + MOUSE', `WASD\nMOUSE\nHOLD CLICK${aimLine('Q')}\nM`, `MOVE\nAIM\nFIRE${aimAction}\nSOUND ON/OFF`);
    column(304, 'CONTROLLER', `L-STICK\nR-STICK\nRT${aimLine('BACK')}\nY`, `MOVE\nAIM + FIRE\nFIRE${aimAction}\nSOUND ON/OFF`);
    this.padStatus = text(cx, 218, '', 8, TEXT.dim);
  }

  update(_time: number, delta: number) {
    this.drawStars(delta / 1000);
    const m = this.controls.readMenu();
    if (m.mute) toggleMute(this);
    if (!this.leaving) {
      if ((m.up || m.down) && MENU.length > 1) {
        this.selected = (this.selected + (m.down ? 1 : MENU.length - 1)) % MENU.length;
        playSound(this, 'select');
      }
      if (AIM_MODE_SELECTABLE && (m.toggleAim || (MENU[this.selected] === 'aim' && (m.left || m.right)))) this.toggleAim();
      else if (m.confirm) this.activate(this.selected);
    }

    const snap8 = this.registry.get(SNAP8) as boolean;
    const labels = { start: 'START', aim: `AIM: ${snap8 ? '8-WAY' : '360'}` };
    this.menu.forEach((item, i) => {
      const on = i === this.selected;
      const label = labels[MENU[i]];
      item.setText(on ? (MENU[i] === 'aim' ? `< ${label} >` : `> ${label} <`) : label).setColor(on ? TEXT.amber : TEXT.dim);
    });

    const pad = this.controls.pad();
    this.padStatus
      .setText(pad ? 'CONTROLLER CONNECTED' : 'USING A CONTROLLER? PRESS ANY BUTTON ON IT')
      .setColor(pad ? TEXT.beam : TEXT.dim);
  }

  private activate(index: number) {
    if (this.leaving) return;
    if (MENU[index] === 'aim') {
      this.toggleAim();
      return;
    }
    this.leaving = true;
    playSound(this, 'start');
    this.cameras.main.fadeOut(250);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => this.scene.start('room'));
  }

  private toggleAim() {
    this.registry.set(SNAP8, !this.registry.get(SNAP8));
  }

  private drawStars(dt: number) {
    const g = this.starfield.clear();
    for (const s of this.stars) {
      s.y += s.speed * dt;
      if (s.y > HEIGHT) {
        s.y = 0;
        s.x = Math.random() * WIDTH;
      }
      g.fillStyle(0xffffff, s.alpha).fillRect(Math.round(s.x), Math.round(s.y), 1, 1);
    }
  }
}
