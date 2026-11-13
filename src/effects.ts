import Phaser from 'phaser';
import { COLS, FX, HUD_H, ROWS, TILE } from './config';

const STREAK = 'fx-streak';
const WHITE = 0xffffff;

/** Slows particles down over their life, so sparks fly out fast and hang in the air. */
class Drag extends Phaser.GameObjects.Particles.ParticleProcessor {
  constructor(private readonly perSecond: number) {
    super(0, 0, true);
  }

  override update(p: Phaser.GameObjects.Particles.Particle, _delta: number, step: number) {
    const k = Math.exp(-this.perSecond * step);
    p.velocityX *= k;
    p.velocityY *= k;
  }
}

/**
 * A springy grid over the room floor. Explosions push it outward, spawns pull it in, and the ripples settle.
 * Each point stores only its offset from rest; the border is pinned to the walls.
 */
class WarpGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly x0 = TILE;
  private readonly y0 = HUD_H + TILE;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly g: Phaser.GameObjects.Graphics;
  /** Grows with every disturbance and fades as the grid settles; brightens the lines. */
  private energy = 0;
  private hue = Math.random();

  constructor(scene: Phaser.Scene) {
    const s = FX.grid.spacing;
    this.cols = ((COLS - 2) * TILE) / s + 1;
    this.rows = ((ROWS - 2) * TILE) / s + 1;
    const n = this.cols * this.rows;
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.g = scene.add.graphics().setDepth(0.5).setBlendMode(Phaser.BlendModes.ADD);
  }

  /** Pushes points within `radius` away from (x, y); a negative strength pulls them in. */
  push(x: number, y: number, strength: number, radius: number) {
    const s = FX.grid.spacing;
    const c0 = Math.max(1, Math.floor((x - radius - this.x0) / s)), c1 = Math.min(this.cols - 2, Math.ceil((x + radius - this.x0) / s));
    const r0 = Math.max(1, Math.floor((y - radius - this.y0) / s)), r1 = Math.min(this.rows - 2, Math.ceil((y + radius - this.y0) / s));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * this.cols + c;
        const px = this.x0 + c * s + this.dx[i] - x, py = this.y0 + r * s + this.dy[i] - y;
        const d = Math.hypot(px, py);
        if (d >= radius || d < 0.001) continue;
        const f = (strength * (1 - d / radius)) / d;
        this.vx[i] += px * f;
        this.vy[i] += py * f;
      }
    }
    this.energy = Math.min(1, this.energy + Math.abs(strength) / 400);
  }

  reset() {
    this.dx.fill(0); this.dy.fill(0); this.vx.fill(0); this.vy.fill(0);
    this.energy = 0;
  }

  update(dt: number) {
    const { stiffness, coupling, damping, maxOffset } = FX.grid;
    const { cols, rows, dx, dy, vx, vy } = this;
    // Small fixed steps keep the springs stable however long the frame was.
    for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
          const i = r * cols + c;
          const lx = dx[i - 1] + dx[i + 1] + dx[i - cols] + dx[i + cols] - 4 * dx[i];
          const ly = dy[i - 1] + dy[i + 1] + dy[i - cols] + dy[i + cols] - 4 * dy[i];
          vx[i] += (coupling * lx - stiffness * dx[i] - damping * vx[i]) * h;
          vy[i] += (coupling * ly - stiffness * dy[i] - damping * vy[i]) * h;
        }
      }
      for (let i = 0; i < dx.length; i++) {
        dx[i] = Phaser.Math.Clamp(dx[i] + vx[i] * h, -maxOffset, maxOffset);
        dy[i] = Phaser.Math.Clamp(dy[i] + vy[i] * h, -maxOffset, maxOffset);
      }
    }
    this.energy *= Math.exp(-1.5 * dt);
    this.hue = (this.hue + dt / FX.grid.hueCycleSeconds) % 1;
    this.draw();
  }

  private draw() {
    const { cols, rows, dx, dy, x0, y0 } = this;
    const s = FX.grid.spacing;
    const color = Phaser.Display.Color.HSVToRGB(this.hue, 0.7, 1) as Phaser.Display.Color;
    const g = this.g.clear().lineStyle(FX.grid.lineWidth, color.color, FX.grid.alpha + this.energy * FX.grid.flashAlpha);
    for (let r = 0; r < rows; r++) {
      g.beginPath();
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c === 0) g.moveTo(x0 + c * s + dx[i], y0 + r * s + dy[i]);
        else g.lineTo(x0 + c * s + dx[i], y0 + r * s + dy[i]);
      }
      g.strokePath();
    }
    for (let c = 0; c < cols; c++) {
      g.beginPath();
      for (let r = 0; r < rows; r++) {
        const i = r * cols + c;
        if (r === 0) g.moveTo(x0 + c * s + dx[i], y0 + r * s + dy[i]);
        else g.lineTo(x0 + c * s + dx[i], y0 + r * s + dy[i]);
      }
      g.strokePath();
    }
  }
}

export type BurstSize = 'small' | 'big' | 'huge';

/** `shake` is in game pixels (Phaser's own camera shake scales with canvas size and zoom, far too much at 4×). */
const BURSTS: Record<BurstSize, { sparks: number; speed: number; life: number; ring: number; push: number; reach: number; shake: number }> = {
  small: { sparks: 28, speed: 150, life: 450, ring: 14, push: 260, reach: 36, shake: 0.8 },
  big: { sparks: 70, speed: 210, life: 650, ring: 26, push: 480, reach: 60, shake: 1.8 },
  huge: { sparks: 160, speed: 260, life: 900, ring: 44, push: 900, reach: 110, shake: 3.5 },
};

/**
 * The room's eye candy: neon spark bursts, shockwave rings, the warping floor grid, bloom on everything bright,
 * and screen wobble (lens bulge, hue swing, camera roll). One per scene; call update() every frame.
 */
export class Effects {
  private readonly grid: WarpGrid | undefined;
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly rings: Phaser.GameObjects.Group;
  private readonly barrel: Phaser.Filters.Barrel | undefined;
  private readonly hue: Phaser.Filters.ColorMatrix | undefined;
  /** Lens bulge, hue swing and camera roll all ease back to rest from these. */
  private wobble = { bulge: 0, hue: 0, roll: 0, rollPhase: 0, shake: 0 };
  /** The camera's resting scroll; shake jiggles around it. */
  private readonly rest: { x: number; y: number };
  // The next burst's settings, read by the emitter's onEmit callbacks.
  private palette = [WHITE];
  private speed = 100;
  private life = 400;
  private spread = { from: 0, range: 360 };

  constructor(private readonly scene: Phaser.Scene) {
    if (!scene.textures.exists(STREAK)) {
      const g = scene.make.graphics({}, false);
      g.fillStyle(WHITE).fillRect(0, 0, 4, 1);
      g.generateTexture(STREAK, 4, 1);
      g.destroy();
    }
    if (FX.grid.enabled) this.grid = new WarpGrid(scene);
    this.rings = scene.add.group();

    let angle = 0;
    this.sparks = scene.add.particles(0, 0, STREAK, {
      emitting: false,
      blendMode: Phaser.BlendModes.ADD,
      // rotate is worked out before angle, so it picks the direction and angle reuses it: each streak points where it flies.
      rotate: { onEmit: () => (angle = this.spread.from + Math.random() * this.spread.range) },
      angle: { onEmit: () => angle },
      speed: { onEmit: () => this.speed * (0.25 + Math.random() * 0.75) },
      lifespan: { onEmit: () => this.life * (0.5 + Math.random() * 0.5) },
      tint: { onEmit: () => Phaser.Utils.Array.GetRandom(this.palette) },
      scaleX: { start: 1.6, end: 0.3 },
      scaleY: 1,
      alpha: { start: 1, end: 0 },
    }).setDepth(20);
    this.sparks.addParticleProcessor(new Drag(4));

    const cam = scene.cameras.main;
    this.rest = { x: cam.scrollX, y: cam.scrollY };
    if (scene.game.renderer.type === Phaser.WEBGL) {
      if (FX.bloom.enabled) {
        const bloom = cam.filters.internal.addParallelFilters();
        bloom.top.addThreshold(FX.bloom.threshold, 1);
        bloom.top.addBlur(0, FX.bloom.offset, FX.bloom.offset, FX.bloom.spread, WHITE, FX.bloom.steps);
        bloom.blend.blendMode = Phaser.BlendModes.ADD;
        bloom.blend.amount = FX.bloom.amount;
      }
      this.barrel = cam.filters.internal.addBarrel(1).setActive(false);
      this.hue = cam.filters.internal.addColorMatrix().setActive(false);
    }
  }

  /** An explosion: sparks in the given colours, a shockwave ring, a dent in the grid and a shake. */
  burst(x: number, y: number, colors: number[], size: BurstSize = 'small') {
    const b = BURSTS[size];
    this.emit(x, y, b.sparks, [...colors, ...colors, WHITE], b.speed, b.life);
    this.ring(x, y, colors[0], b.ring, b.life * 0.7);
    if (size !== 'small') this.ring(x, y, WHITE, b.ring * 0.6, b.life * 0.5);
    this.grid?.push(x, y, b.push, b.reach);
    this.wobble.shake = Math.max(this.wobble.shake, b.shake);
    if (size === 'big') this.kick(0.05, 25, 0);
    if (size === 'huge') this.kick(0.12, 45, 0.03);
  }

  /** Something is taking beam damage at (x, y): sparks spray back along the beam and the grid ripples. */
  hit(x: number, y: number, beamAngle: number, color: number) {
    this.emit(x, y, 2, [color, WHITE], 110, 260, Phaser.Math.RadToDeg(beamAngle) + 180 - 50, 100);
    this.grid?.push(x, y, 40, 18);
  }

  /** Something arriving: a ring that closes in and the grid sucked toward it. */
  implode(x: number, y: number, color: number) {
    this.ring(x, y, color, 18, 380, true);
    this.grid?.push(x, y, -220, 34);
  }

  /** A celebration or a puff: sparks and a ring, with no shake or grid dent. */
  pop(x: number, y: number, colors: number[], sparks: number) {
    this.emit(x, y, sparks, [...colors, WHITE], 120, 520);
    this.ring(x, y, colors[0], 10 + sparks / 6, 420);
  }

  /** Called on room change: nothing from the last room carries over. */
  clear() {
    this.sparks.killAll();
    for (const r of this.rings.getChildren()) this.scene.tweens.killTweensOf(r);
    this.rings.clear(true, true);
    this.grid?.reset();
  }

  update(dt: number) {
    this.grid?.update(dt);
    const w = this.wobble;
    const ease = Math.exp(-4 * dt);
    w.bulge *= ease;
    w.hue *= ease;
    w.roll *= Math.exp(-3 * dt);
    w.rollPhase += dt * 22;
    w.shake = w.shake * Math.exp(-7 * dt);
    if (w.shake < 0.05) w.shake = 0;
    if (this.barrel) {
      this.barrel.setActive(w.bulge > 0.002);
      this.barrel.amount = 1 + w.bulge * Math.cos(w.rollPhase * 0.7);
    }
    if (this.hue) {
      this.hue.setActive(w.hue > 0.5);
      this.hue.colorMatrix.hue(w.hue);
    }
    const cam = this.scene.cameras.main;
    cam.setRotation(w.roll > 0.0005 ? w.roll * Math.sin(w.rollPhase) : 0);
    cam.setScroll(this.rest.x + (Math.random() * 2 - 1) * w.shake, this.rest.y + (Math.random() * 2 - 1) * w.shake);
  }

  /** Screen wobble: lens bulge (barrel amount), a hue swing in degrees and a camera roll in radians. */
  private kick(bulge: number, hue: number, roll: number) {
    const w = this.wobble;
    w.bulge = Math.max(w.bulge, bulge);
    w.hue = Math.max(w.hue, hue);
    if (roll > w.roll) {
      w.roll = roll;
      w.rollPhase = 0;
    }
  }

  private emit(x: number, y: number, count: number, palette: number[], speed: number, life: number, from = 0, range = 360) {
    this.palette = palette;
    this.speed = speed;
    this.life = life;
    this.spread = { from, range };
    this.sparks.explode(count, x, y);
  }

  private ring(x: number, y: number, color: number, radius: number, ms: number, inward = false) {
    const g = this.scene.add.graphics().setDepth(19).setBlendMode(Phaser.BlendModes.ADD);
    this.rings.add(g);
    const t = { p: 0 };
    this.scene.tweens.add({
      targets: t, p: 1, duration: ms, ease: inward ? 'Quad.in' : 'Quad.out',
      onUpdate: () => {
        const r = inward ? radius * (1 - t.p) + 1 : 2 + radius * t.p;
        g.clear().lineStyle(inward ? 1 : 2 - t.p, color, 1 - t.p * (inward ? 0.3 : 1)).strokeCircle(x, y, r);
      },
      onComplete: () => g.destroy(),
    });
  }
}
