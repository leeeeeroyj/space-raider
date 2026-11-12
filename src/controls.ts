import Phaser from 'phaser';
import { RENDER_SCALE, TOUCH_STICKS } from './config';

export type Device = 'kbm' | 'pad' | 'touch';

export interface ControlState {
  /** Movement, length 0..1. */
  move: Phaser.Math.Vector2;
  /** Aim angle in radians (0 = right). */
  aim: number;
  fire: boolean;
  toggleAim: boolean;
  confirm: boolean;
  back: boolean;
  mute: boolean;
  device: Device;
}

export interface MenuState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
  toggleAim: boolean;
  mute: boolean;
  device: Device;
}

const DEADZONE = 0.2;
const AIM_THRESHOLD = 0.35;
const TRIGGER_THRESHOLD = 0.3;
const MENU_STICK = 0.5;
const TOUCH_DEADZONE = 0.15;
const TOUCH_AIM_THRESHOLD = 0.3;

export type ThumbStick = 'move' | 'aim';
/** Where a thumb is on its stick: -1..1 on each axis, length at most 1. */
export type Thumbs = Partial<Record<ThumbStick, Phaser.Math.Vector2>>;
// Standard gamepad mapping (Xbox layout).
const BTN = { A: 0, B: 1, Y: 3, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const TRACKED = Object.values(BTN);

type KeyName = 'W' | 'A' | 'S' | 'D' | 'Q' | 'M' | 'ENTER' | 'SPACE' | 'ESC' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/**
 * One input layer for keyboard + mouse and a controller. Whichever was used last owns the aim.
 * Controller: left stick or D-pad moves, right stick aims and fires, RT/RB fire, Y toggles sound, Back toggles aim mode.
 * Touch: two fixed sticks in the bottom corners (TOUCH_STICKS): left moves, right aims and fires. The HUD draws them.
 * Construct one per scene.
 */
export class Controls {
  device: Device = 'kbm';
  /** False until the mouse has moved over the game, so no crosshair is drawn at (0, 0). */
  mouseSeen = false;
  private padAim = -Math.PI / 2;
  private touchAim = -Math.PI / 2;
  /** Which pointer is holding each stick. */
  private held: Partial<Record<ThumbStick, number>> = {};
  /** Latest stick positions, for drawing the knobs. */
  thumbs: Thumbs = {};
  private prevButtons = new Set<number>();
  private prevStick = { x: 0, y: 0 };
  private readonly keys: Record<KeyName, Phaser.Input.Keyboard.Key>;

  constructor(private readonly scene: Phaser.Scene) {
    this.keys = scene.input.keyboard!.addKeys('W,A,S,D,Q,M,ENTER,SPACE,ESC,UP,DOWN,LEFT,RIGHT') as Controls['keys'];
    scene.input.mouse?.disableContextMenu();
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p.wasTouch) return;
      this.device = 'kbm';
      this.mouseSeen = true;
    });
    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.device = 'kbm';
        return;
      }
      this.device = 'touch';
      this.claimTouch(p);
    });
    const release = (p: Phaser.Input.Pointer) => {
      if (this.held.move === p.id) this.held.move = undefined;
      if (this.held.aim === p.id) this.held.aim = undefined;
    };
    scene.input.on('pointerup', release);
    scene.input.on('pointerupoutside', release);
  }

  /** A thumb that lands on or near a stick's circle takes that stick. Touches anywhere else are ignored. */
  private claimTouch(p: Phaser.Input.Pointer) {
    for (const which of ['move', 'aim'] as const) {
      const c = TOUCH_STICKS[which];
      const reach = TOUCH_STICKS.radius * TOUCH_STICKS.grab * RENDER_SCALE;
      if (this.held[which] === undefined && Math.hypot(p.x - c.x * RENDER_SCALE, p.y - c.y * RENDER_SCALE) <= reach) {
        this.held[which] = p.id;
        return;
      }
    }
  }

  /** The thumb's offset from the stick's centre, as -1..1 (clamped to the rim). Lets go if that finger has lifted. */
  private stickVector(which: ThumbStick): Phaser.Math.Vector2 | undefined {
    const id = this.held[which];
    if (id === undefined) return undefined;
    const p = this.scene.input.manager.pointers.find((ptr) => ptr.id === id);
    if (!p || !p.isDown) {
      this.held[which] = undefined;
      return undefined;
    }
    const c = TOUCH_STICKS[which], radius = TOUCH_STICKS.radius * RENDER_SCALE;
    const v = new Phaser.Math.Vector2(p.x - c.x * RENDER_SCALE, p.y - c.y * RENDER_SCALE).scale(1 / radius);
    return v.length() > 1 ? v.normalize() : v;
  }

  /** The first connected controller, if the browser has seen one (it needs a button press first). */
  pad(): Phaser.Input.Gamepad.Gamepad | undefined {
    const pad = this.scene.input.gamepad?.pad1;
    return pad && pad.connected ? pad : undefined;
  }

  /** Buttons pressed this frame that weren't pressed last frame. Call once per frame. */
  private padEdges(pad: Phaser.Input.Gamepad.Gamepad | undefined) {
    const down = new Set(pad ? TRACKED.filter((i) => pad.buttons[i]?.pressed) : []);
    const edges = new Set([...down].filter((i) => !this.prevButtons.has(i)));
    this.prevButtons = down;
    if (edges.size) this.device = 'pad';
    return edges;
  }

  read(from: { x: number; y: number }): ControlState {
    const k = this.keys;
    const just = Phaser.Input.Keyboard.JustDown;
    const pointer = this.scene.input.activePointer;
    const move = new Phaser.Math.Vector2((k.D.isDown ? 1 : 0) - (k.A.isDown ? 1 : 0), (k.S.isDown ? 1 : 0) - (k.W.isDown ? 1 : 0));
    if (move.lengthSq() > 0) move.normalize();

    // Phaser reports a touch as a held left button, so only a real mouse fires this way.
    let fire = !pointer.wasTouch && pointer.leftButtonDown();
    let toggleAim = just(k.Q);
    let confirm = just(k.ENTER) || just(k.SPACE);
    let back = just(k.ESC);
    let mute = just(k.M);

    const pad = this.pad();
    const edges = this.padEdges(pad);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : v);
      let mx = dz(pad.leftStick.x);
      let my = dz(pad.leftStick.y);
      if (pad.left) mx = -1;
      if (pad.right) mx = 1;
      if (pad.up) my = -1;
      if (pad.down) my = 1;
      if (mx || my) {
        move.set(mx, my);
        if (move.length() > 1) move.normalize();
        this.device = 'pad';
      }
      const stick = pad.rightStick;
      if (stick.length() > AIM_THRESHOLD) {
        this.padAim = Math.atan2(stick.y, stick.x);
        fire = true;
        this.device = 'pad';
      }
      if (pad.R2 > TRIGGER_THRESHOLD || pad.R1 > TRIGGER_THRESHOLD) {
        fire = true;
        this.device = 'pad';
      }
      if (edges.has(BTN.BACK)) toggleAim = true;
      if (edges.has(BTN.START) || edges.has(BTN.A)) confirm = true;
      if (edges.has(BTN.B)) back = true;
      if (edges.has(BTN.Y)) mute = true;
    }

    const thumbMove = this.stickVector('move');
    const thumbAim = this.stickVector('aim');
    this.thumbs = { move: thumbMove, aim: thumbAim };
    if (thumbMove && thumbMove.length() > TOUCH_DEADZONE) {
      move.copy(thumbMove);
      this.device = 'touch';
    }
    if (thumbAim && thumbAim.length() > TOUCH_AIM_THRESHOLD) {
      this.touchAim = Math.atan2(thumbAim.y, thumbAim.x);
      fire = true;
      this.device = 'touch';
    }

    const aim =
      this.device === 'pad' ? this.padAim
      : this.device === 'touch' ? this.touchAim
      : Math.atan2(pointer.worldY - from.y, pointer.worldX - from.x);
    return { move, aim, fire, toggleAim, confirm, back, mute, device: this.device };
  }

  readMenu(): MenuState {
    const k = this.keys;
    const just = Phaser.Input.Keyboard.JustDown;
    const s: MenuState = {
      up: just(k.W) || just(k.UP),
      down: just(k.S) || just(k.DOWN),
      left: just(k.A) || just(k.LEFT),
      right: just(k.D) || just(k.RIGHT),
      confirm: just(k.ENTER) || just(k.SPACE),
      back: just(k.ESC),
      toggleAim: just(k.Q),
      mute: just(k.M),
      device: this.device,
    };
    if (Object.values(s).some((v) => v === true)) this.device = s.device = 'kbm';

    const pad = this.pad();
    const edges = this.padEdges(pad);
    if (pad) {
      // The left stick acts like a D-pad: one step each time it crosses the threshold.
      const x = pad.leftStick.x, y = pad.leftStick.y;
      const crossed = (now: number, before: number, sign: number) => now * sign > MENU_STICK && before * sign <= MENU_STICK;
      s.up ||= edges.has(BTN.UP) || crossed(y, this.prevStick.y, -1);
      s.down ||= edges.has(BTN.DOWN) || crossed(y, this.prevStick.y, 1);
      s.left ||= edges.has(BTN.LEFT) || crossed(x, this.prevStick.x, -1);
      s.right ||= edges.has(BTN.RIGHT) || crossed(x, this.prevStick.x, 1);
      s.confirm ||= edges.has(BTN.A) || edges.has(BTN.START);
      s.back ||= edges.has(BTN.B);
      s.toggleAim ||= edges.has(BTN.BACK);
      s.mute ||= edges.has(BTN.Y);
      if (Math.abs(x) > MENU_STICK || Math.abs(y) > MENU_STICK) this.device = 'pad';
      this.prevStick = { x, y };
      s.device = this.device;
    }
    return s;
  }
}
