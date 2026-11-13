import Phaser from 'phaser';
import { TOUCH_STICKS, WIDTH } from './config';

export type ThumbStick = 'move' | 'aim';

const STICKS: ThumbStick[] = ['move', 'aim'];
const COLORS: Record<ThumbStick, string> = { move: '255, 181, 71', aim: '94, 242, 255' };
/** Gap (CSS px) kept between a stick and the screen or game edge. */
const MARGIN = 8;

type Layout = { radius: number; centers: Record<ThumbStick, { x: number; y: number }>; sides: boolean; gutter: number };

/**
 * The two touch sticks, drawn as page elements so they can sit in the empty bars beside the game on wide phones.
 * When the bars are too narrow they sit over the game's bottom corners instead (TOUCH_STICKS).
 * Touches are read from the whole page, because Phaser only hears touches that start on its canvas.
 */
class TouchSticks {
  /** Which touch (pointerId) holds each stick, and where that finger is now (CSS px). */
  private held: Partial<Record<ThumbStick, { id: number; x: number; y: number }>> = {};
  private els: Record<ThumbStick, { ring: HTMLDivElement; knob: HTMLDivElement }> | undefined;
  private shown = false;
  private touched = false;
  private readonly coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;

  constructor() {
    window.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => {
      for (const which of STICKS) {
        const h = this.held[which];
        if (h?.id === e.pointerId) Object.assign(h, { x: e.clientX, y: e.clientY });
      }
    });
    const up = (e: PointerEvent) => {
      for (const which of STICKS) if (this.held[which]?.id === e.pointerId) this.held[which] = undefined;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Shown during play on touch screens (or once the screen has been touched); hidden on the title screen. */
  show(on: boolean) {
    this.shown = on;
    if (!on) this.held = {};
    this.render();
  }

  get active() {
    return this.held.move !== undefined || this.held.aim !== undefined;
  }

  /** The thumb's offset from the stick's centre, -1..1 on each axis and clamped to the rim. Also redraws the knobs. */
  vector(which: ThumbStick): Phaser.Math.Vector2 | undefined {
    const h = this.held[which];
    if (!h) return undefined;
    const { radius, centers } = this.layout();
    const v = new Phaser.Math.Vector2(h.x - centers[which].x, h.y - centers[which].y).scale(1 / radius);
    return v.length() > 1 ? v.normalize() : v;
  }

  /** Redraws both sticks. Call once per frame while playing. */
  render() {
    const visible = this.shown && (this.coarse || this.touched);
    if (!visible) {
      if (this.els) for (const which of STICKS) this.els[which].ring.style.display = 'none';
      return;
    }
    const els = (this.els ??= this.build());
    const { radius, centers } = this.layout();
    for (const which of STICKS) {
      const { ring, knob } = els[which];
      const c = centers[which], v = this.vector(which), on = Boolean(v), rgb = COLORS[which];
      Object.assign(ring.style, {
        display: 'block', left: `${c.x - radius}px`, top: `${c.y - radius}px`, width: `${radius * 2}px`, height: `${radius * 2}px`,
        background: `rgba(${rgb}, 0.08)`, border: `2px solid rgba(${rgb}, ${on ? 0.6 : 0.35})`,
      });
      const k = radius * 0.4;
      Object.assign(knob.style, {
        width: `${k * 2}px`, height: `${k * 2}px`, background: `rgba(${rgb}, ${on ? 0.55 : 0.25})`,
        transform: `translate(${radius - k - 2 + (v?.x ?? 0) * radius}px, ${radius - k - 2 + (v?.y ?? 0) * radius}px)`,
      });
    }
  }

  private down(e: PointerEvent) {
    if (e.pointerType !== 'touch' || !this.shown) return;
    this.touched = true;
    const { radius, centers, sides, gutter } = this.layout();
    for (const which of STICKS) {
      if (this.held[which]) continue;
      const c = centers[which];
      const near = Math.hypot(e.clientX - c.x, e.clientY - c.y) <= radius * TOUCH_STICKS.grab;
      // Beside the game, anywhere in that side's bar takes the stick.
      const inBar = sides && (which === 'move' ? e.clientX < gutter : e.clientX > window.innerWidth - gutter);
      if (near || inBar) {
        this.held[which] = { id: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
    }
  }

  private layout(): Layout {
    const canvas = document.querySelector('#game canvas');
    const rect = canvas?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const k = rect.width / WIDTH;
    const base = TOUCH_STICKS.radius * k;
    const gutter = Math.min(rect.left, window.innerWidth - rect.right);
    const y = Math.min(rect.top + TOUCH_STICKS.move.y * k, window.innerHeight - base - MARGIN);
    if (gutter >= base * 2 + MARGIN * 2) {
      const radius = Math.min(base * 1.25, gutter / 2 - MARGIN);
      return { radius, sides: true, gutter, centers: { move: { x: gutter / 2, y }, aim: { x: window.innerWidth - gutter / 2, y } } };
    }
    return {
      radius: base, sides: false, gutter,
      centers: {
        move: { x: rect.left + TOUCH_STICKS.move.x * k, y: rect.top + TOUCH_STICKS.move.y * k },
        aim: { x: rect.left + TOUCH_STICKS.aim.x * k, y: rect.top + TOUCH_STICKS.aim.y * k },
      },
    };
  }

  private build() {
    const make = () => {
      const ring = document.createElement('div');
      const knob = document.createElement('div');
      Object.assign(ring.style, { position: 'fixed', borderRadius: '50%', pointerEvents: 'none', zIndex: '5', boxSizing: 'border-box' });
      Object.assign(knob.style, { position: 'absolute', left: '0', top: '0', borderRadius: '50%' });
      ring.append(knob);
      document.body.append(ring);
      return { ring, knob };
    };
    return { move: make(), aim: make() };
  }
}

export const touchSticks = new TouchSticks();
