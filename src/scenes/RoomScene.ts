import Phaser from 'phaser';
import {
  AIM_MODE_SELECTABLE, BEAM, BROOD, COLORS, COLS, FONT, HUD_H, HUD_STATE, HUNTER, INTERIOR, MINE, PLAYER, RENDER_SCALE, ROOM_H,
  ROOM_W, ROWS, SCAVENGER, SCORING, SENTRY, SNAP8, TEXT, TILE, TREASURE, WARDEN, tileCenter, type TreasureKind,
} from '../config';
import { Controls } from '../controls';
import { addGlow, addTreasureGlow, startSparkles } from '../fx';
import { loopSound, playSound, toggleMute } from '../sfx';
import { fitCamera } from '../view';
import {
  GRID, OPPOSITE, SIDES, generateVault, hostileCount, mapCell, neighbor, roomIndex,
  type Foe, type FoeKind, type Loot, type Room, type Side, type Vault,
} from '../vault';
import type { HudState } from './HudScene';

type Enemy = Phaser.Physics.Arcade.Sprite;
type EnemyKind = 'hunter' | FoeKind;

const CENTER = tileCenter(10, 6);
const BOLT = 'fx-bolt';
const pts = (n: number) => n.toLocaleString('en-US');
const ENEMY_HP: Record<EnemyKind, number> = { hunter: HUNTER.hp, sentry: SENTRY.hp, mine: MINE.hp, warden: WARDEN.hp, brood: BROOD.hp };
const ENEMY_POINTS: Record<EnemyKind, number> = {
  hunter: HUNTER.points, sentry: SENTRY.points, mine: MINE.points, warden: WARDEN.points, brood: BROOD.points,
};

/** Is wall tile (col, row) an open doorway in this room? */
function inDoor(room: Room, col: number, row: number) {
  const { top, bottom, left, right } = room.doors;
  if (row === 0 && top) return col >= top.from && col <= top.to;
  if (row === ROWS - 1 && bottom) return col >= bottom.from && col <= bottom.to;
  if (col === 0 && left) return row >= left.from && row <= left.to;
  if (col === COLS - 1 && right) return row >= right.from && row <= right.to;
  return false;
}
const isEdge = (col: number, row: number) => row === 0 || col === 0 || row === ROWS - 1 || col === COLS - 1;
const besideDoor = (room: Room, col: number, row: number) =>
  !inDoor(room, col, row) && [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dc, dr]) => inDoor(room, col + dc, row + dr));

/** Tile centres of every doorway tile in the room: where drones come in. */
function doorTiles(room: Room) {
  const points: Array<{ x: number; y: number }> = [];
  for (const side of SIDES) {
    const d = room.doors[side];
    if (!d) continue;
    for (let i = d.from; i <= d.to; i++) {
      if (side === 'top') points.push(tileCenter(i, 0));
      if (side === 'bottom') points.push(tileCenter(i, ROWS - 1));
      if (side === 'left') points.push(tileCenter(0, i));
      if (side === 'right') points.push(tileCenter(COLS - 1, i));
    }
  }
  return points;
}

/** Just inside the doorway on `side`: where you appear after coming through it. */
function entryPoint(room: Room, side: Side) {
  const d = room.doors[side]!;
  const mid = ((d.from + d.to + 1) / 2) * TILE;
  if (side === 'top') return { x: mid, y: HUD_H + TILE + 8 };
  if (side === 'bottom') return { x: mid, y: HUD_H + (ROWS - 2) * TILE + 8 };
  if (side === 'left') return { x: TILE + 8, y: HUD_H + mid };
  return { x: (COLS - 2) * TILE + 8, y: HUD_H + mid };
}

/** Distance along a unit ray from (ox, oy) to the circle, or Infinity on a miss. */
function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number) {
  const fx = ox - cx, fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  if (-b - s >= 0) return -b - s;
  return -b + s >= 0 ? 0 : Infinity;
}

/** Distance along a unit ray to the inner edge of the wall ring. */
function rayToWall(ox: number, oy: number, dx: number, dy: number) {
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (INTERIOR.x1 - ox) / dx);
  if (dx < 0) t = Math.min(t, (INTERIOR.x0 - ox) / dx);
  if (dy > 0) t = Math.min(t, (INTERIOR.y1 - oy) / dy);
  if (dy < 0) t = Math.min(t, (INTERIOR.y0 - oy) / dy);
  return Math.max(0, t);
}

/**
 * Signpost arrows, as pixels on a 15×15 grid: pointing right, or down-right. The other six directions are exact
 * 90° turns of these, so no rotated (blurred) pixels.
 */
function arrowPixels(diagonal: boolean) {
  const px: Array<[number, number]> = [];
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const on = diagonal
        ? (x <= 12 && y <= 12 && x + y >= 19) || (x >= 2 && y >= 2 && x <= 10 && y <= 10 && Math.abs(x - y) <= 1)
        : (y >= 6 && y <= 8 && x >= 1 && x <= 8) || (x >= 8 && x <= 13 && Math.abs(y - 7) <= 13 - x);
      if (on) px.push([x, y]);
    }
  }
  return px;
}

/** Textures sign-0 … sign-7: east, then clockwise in 45° steps (matching atan2 with y pointing down). */
function makeSignTextures(scene: Phaser.Scene) {
  if (scene.textures.exists('sign-0')) return;
  for (let d = 0; d < 8; d++) {
    let px = arrowPixels(d % 2 === 1);
    for (let turn = 0; turn < Math.floor(d / 2); turn++) px = px.map(([x, y]) => [14 - y, x]);
    const g = scene.make.graphics({}, false);
    g.fillStyle(COLORS.void);
    for (const [x, y] of px) g.fillRect(x + 1, y + 1, 1, 1);
    g.fillStyle(COLORS.amber);
    for (const [x, y] of px) g.fillRect(x, y, 1, 1);
    g.generateTexture(`sign-${d}`, 16, 16);
    g.destroy();
  }
}

const insideInterior = (x: number, y: number) => x > INTERIOR.x0 && x < INTERIOR.x1 && y > INTERIOR.y0 && y < INTERIOR.y1;

export class RoomScene extends Phaser.Scene {
  private controls!: Controls;
  private player!: Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
  private walls!: Phaser.Physics.Arcade.StaticGroup;
  private enemies!: Phaser.Physics.Arcade.Group;
  private scavengers!: Phaser.Physics.Arcade.Group;
  private bolts!: Phaser.Physics.Arcade.Group;
  private treasures!: Phaser.Physics.Arcade.StaticGroup;
  private pads!: Phaser.Physics.Arcade.StaticGroup;
  private doorGlow: Phaser.GameObjects.Graphics | undefined;
  private beam!: Phaser.GameObjects.Graphics;
  private crosshair!: Phaser.GameObjects.Graphics;
  private banner!: Phaser.GameObjects.Text;
  private subBanner!: Phaser.GameObjects.Text;
  private bannerFade: Phaser.Tweens.Tween | undefined;
  /** Things drawn for the current room only (signpost, floating text, debris), cleared on the way out. */
  private roomFx!: Phaser.GameObjects.Group;
  private beamSound: Phaser.Sound.WebAudioSound | undefined;

  private vault!: Vault;
  private room!: Room;
  private runSeed = '';
  private score = 0;
  private lives = PLAYER.lives;
  private cargo: TreasureKind[] = [];
  private snap8 = false;
  private dead = false;
  private over = false;
  private banking = false;
  private overAt = 0;
  private invulnerableUntil = 0;
  private nextSpawnAt = 0;
  /** A scavenger can show up once per room visit, decided the first time you're in the room with cargo. */
  private scavengerRolled = false;
  private scavengerDue: number | undefined;

  constructor() {
    super('room');
  }

  create() {
    // Scene.restart() reuses this instance, so all run state is reset here.
    Object.assign(this, {
      score: 0, lives: PLAYER.lives, cargo: [], dead: false, over: false, banking: false, invulnerableUntil: 0,
      doorGlow: undefined, bannerFade: undefined, runSeed: `${Date.now()}-${Math.random()}`,
      scavengerRolled: false, scavengerDue: undefined,
    });
    this.snap8 = AIM_MODE_SELECTABLE && this.registry.get(SNAP8) === true;
    fitCamera(this, RENDER_SCALE);
    this.input.setDefaultCursor('none');
    this.scene.launch('hud');
    if (!this.textures.exists(BOLT)) {
      const g = this.make.graphics({}, false);
      g.fillStyle(COLORS.danger).fillRect(0, 0, 5, 5);
      g.fillStyle(0xffffff).fillRect(1, 1, 3, 3);
      g.generateTexture(BOLT, 5, 5);
      g.destroy();
    }

    makeSignTextures(this);
    this.beamSound = loopSound(this, 'beam');
    this.roomFx = this.add.group();

    this.physics.world.setBounds(0, HUD_H, ROOM_W, ROOM_H);
    this.drawFloor();
    this.walls = this.physics.add.staticGroup();
    this.treasures = this.physics.add.staticGroup();
    this.pads = this.physics.add.staticGroup();
    this.enemies = this.physics.add.group();
    this.scavengers = this.physics.add.group();
    this.bolts = this.physics.add.group();

    // No world-bounds collision for the ship: walls stop it, doorways let it through to the next room.
    this.player = this.physics.add.image(CENTER.x, CENTER.y, 'player').setDepth(10);
    this.player.setCircle(PLAYER.radius, 8 - PLAYER.radius, 8 - PLAYER.radius);

    // Scavengers are ghosts: no wall or enemy collisions.
    this.physics.add.collider(this.player, this.walls);
    this.physics.add.collider(this.enemies, this.walls);
    this.physics.add.collider(this.enemies, this.enemies);
    this.physics.add.overlap(this.player, this.enemies, (_p, e) => this.onEnemyTouch(e as Enemy));
    this.physics.add.overlap(this.player, this.scavengers, (_p, s) => this.onScavengerTouch(s as Enemy));
    this.physics.add.overlap(this.player, this.bolts, (_p, b) => this.onBolt(b as Phaser.Physics.Arcade.Sprite));
    this.physics.add.overlap(this.player, this.treasures, (_p, t) => this.collect(t as Phaser.Physics.Arcade.Sprite));
    this.physics.add.overlap(this.player, this.pads, () => this.bank());

    this.beam = this.add.graphics().setDepth(12);
    this.crosshair = this.add.graphics().setDepth(200);
    const mid = { x: ROOM_W / 2, y: HUD_H + ROOM_H / 2 };
    this.banner = this.add.text(mid.x, mid.y - 48, '', { fontFamily: FONT, fontSize: '16px', color: TEXT.amber }).setOrigin(0.5).setDepth(150);
    this.subBanner = this.add.text(mid.x, mid.y - 36, '', { fontFamily: FONT, fontSize: '8px', color: TEXT.ink, align: 'center', lineSpacing: 4 }).setOrigin(0.5, 0).setDepth(150);

    this.controls = new Controls(this);
    startSparkles(this, () => this.treasures.getChildren().filter((t) => t.active) as Phaser.Physics.Arcade.Sprite[]);
    this.time.addEvent({ delay: HUNTER.spawnEveryMs / 3, loop: true, callback: () => this.spawnHunter() });
    this.startVault(1);
  }

  update(time: number, delta: number) {
    const dt = delta / 1000;
    const input = this.controls.read(this.player);
    if (AIM_MODE_SELECTABLE && input.toggleAim) {
      this.snap8 = !this.snap8;
      this.registry.set(SNAP8, this.snap8);
    }
    if (input.mute) toggleMute(this);

    if (this.over) {
      if (time - this.overAt > 800) {
        if (input.confirm) this.scene.restart();
        else if (input.back) this.toTitle();
      }
      this.beam.clear();
      this.beamHum(false);
    } else if (this.banking) {
      this.player.setVelocity(0);
      this.beam.clear();
      this.beamHum(false);
    } else {
      this.updatePlayer(input.move, time);
      this.updateEnemies(time);
      this.updateScavenger(time);
      this.updateBolts();
      this.updateBeam(input.fire && !this.dead, input.aim, dt);
      this.checkDoorways();
    }

    this.crosshair.clear();
    const pointer = this.input.activePointer;
    if (input.device === 'kbm' && this.controls.mouseSeen && pointer.worldX < ROOM_W && pointer.worldY > HUD_H) {
      const x = Math.round(pointer.worldX), y = Math.round(pointer.worldY);
      this.crosshair.fillStyle(COLORS.amber);
      this.crosshair.fillRect(x - 5, y, 3, 1).fillRect(x + 3, y, 3, 1).fillRect(x, y - 5, 1, 3).fillRect(x, y + 3, 1, 3);
    }

    const hud: HudState = {
      score: this.score, lives: this.lives, cargo: this.cargo, device: input.device, level: this.vault.level,
      hostiles: hostileCount(this.room),
      map: {
        cells: this.vault.rooms.map(mapCell),
        current: roomIndex(this.room),
        exit: roomIndex(this.vault.exit),
        wreck: this.vault.wreck ? roomIndex(this.vault.wreck) : -1,
      },
    };
    this.registry.set(HUD_STATE, hud);
  }

  private toTitle() {
    this.scene.stop('hud');
    this.scene.start('title');
  }

  // ---- Vault and rooms ----

  private startVault(level: number) {
    this.vault = generateVault(level, `${this.runSeed}-${level}`);
    this.enterRoom(this.vault.entrance);
    this.showBanner(`VAULT ${level}`, 'FIND THE EXIT. GRAB WHAT GLOWS.', 2000);
  }

  /** Swaps the room's contents for `room`. Hostiles still alive stay counted in the room you left. */
  private enterRoom(room: Room, from?: Side) {
    // Whatever was on screen belonged to the last room: banners, floating text, debris.
    this.hideBanner();
    for (const o of this.roomFx.getChildren()) this.tweens.killTweensOf(o);
    this.roomFx.clear(true, true);
    this.clearHostiles();
    this.treasures.clear(true, true);
    this.walls.clear(true, true);
    this.pads.clear(true, true);
    this.doorGlow?.destroy();

    this.room = room;
    room.visited = true;
    this.buildWalls(room);
    if (room !== this.vault.exit) this.addSignpost(room);
    if (from) playSound(this, 'door');
    for (const loot of room.loot) this.placeTreasure(loot);
    if (room === this.vault.exit) {
      const pad = this.pads.create(CENTER.x, CENTER.y, 'exit') as Phaser.Physics.Arcade.Sprite;
      addGlow(this, pad.setDepth(3), COLORS.beam);
      (pad.body as Phaser.Physics.Arcade.StaticBody).setCircle(4, 4, 4);
      this.showBanner('EXTRACTION', 'FLY ONTO THE PAD TO BANK YOUR CARGO\nAND LEAVE THE VAULT', 2200);
    }

    const at = from ? entryPoint(room, from) : CENTER;
    this.player.body.reset(at.x, at.y);
    this.nextSpawnAt = this.time.now + HUNTER.entryGraceMs;
    this.scavengerRolled = false;
    this.scavengerDue = undefined;
    this.buildFoes();
    this.cameras.main.fadeIn(160);
  }

  /** A floor arrow pointing straight toward the exit room (not the route: you still have to find the doors). */
  private addSignpost(room: Room) {
    const a = Math.atan2(this.vault.exit.row - room.row, this.vault.exit.col - room.col);
    const dir = (((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8);
    const arrow = this.add.image(CENTER.x, CENTER.y, `sign-${dir}`).setDepth(1).setAlpha(0.6);
    const label = this.add.text(CENTER.x, CENTER.y + 13, 'EXIT', { fontFamily: FONT, fontSize: '8px', color: TEXT.amber }).setOrigin(0.5).setDepth(1).setAlpha(0.6);
    this.roomFx.addMultiple([arrow, label]);
    this.tweens.add({ targets: [arrow, label], alpha: 0.25, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  }

  /** Flying through a doorway past the room's edge takes you into the neighbouring room. */
  private checkDoorways() {
    if (this.dead) return;
    const { x, y } = this.player;
    const side: Side | undefined =
      y < HUD_H + 2 ? 'top' : y > HUD_H + ROOM_H - 2 ? 'bottom' : x < 2 ? 'left' : x > ROOM_W - 2 ? 'right' : undefined;
    const next = side && neighbor(this.vault, this.room, side);
    if (side && next) this.enterRoom(next, OPPOSITE[side]);
  }

  private drawFloor() {
    const g = this.add.graphics().setDepth(0);
    const shades = [0x121528, 0x14182d, 0x111324];
    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < COLS - 1; c++) {
        const x = c * TILE, y = HUD_H + r * TILE;
        g.fillStyle(shades[(((c * 73856093) ^ (r * 19349663)) >>> 0) % 3]).fillRect(x, y, TILE, TILE);
        g.fillStyle(0x0c0e1c).fillRect(x, y + TILE - 1, TILE, 1).fillRect(x + TILE - 1, y, 1, TILE);
        g.fillStyle(0x1d2240).fillRect(x + 1, y + 1, 1, 1).fillRect(x + TILE - 3, y + TILE - 3, 1, 1);
      }
    }
  }

  private buildWalls(room: Room) {
    const glow = this.add.graphics().setDepth(1);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!isEdge(c, r)) continue;
        const { x, y } = tileCenter(c, r);
        if (inDoor(room, c, r)) {
          glow.fillStyle(COLORS.void).fillRect(x - 8, y - 8, TILE, TILE);
          glow.fillStyle(COLORS.amber);
          if (r === 0) glow.fillRect(x - 8, y + 6, TILE, 1);
          else if (r === ROWS - 1) glow.fillRect(x - 8, y - 7, TILE, 1);
          else if (c === 0) glow.fillRect(x + 6, y - 8, 1, TILE);
          else glow.fillRect(x - 7, y - 8, 1, TILE);
        } else {
          this.walls.create(x, y, besideDoor(room, c, r) ? 'door' : 'wall').setDepth(2);
        }
      }
    }
    const pulse = this.tweens.add({ targets: glow, alpha: 0.4, duration: 900, yoyo: true, repeat: -1 });
    glow.once(Phaser.GameObjects.Events.DESTROY, () => pulse.remove());
    this.doorGlow = glow;
  }

  // ---- Player ----

  private updatePlayer(move: Phaser.Math.Vector2, time: number) {
    if (this.dead) return;
    this.player.setVelocity(move.x * PLAYER.speed, move.y * PLAYER.speed);
    const shielded = time < this.invulnerableUntil;
    this.player.setAlpha(shielded && Math.floor(time / 80) % 2 ? 0.3 : 1);
  }

  private canBeHit() {
    return !this.dead && !this.over && !this.banking && this.time.now >= this.invulnerableUntil;
  }

  private onEnemyTouch(enemy: Enemy) {
    if (!this.canBeHit() || this.time.now < (enemy.getData('armedAt') as number)) return;
    this.loseShip();
  }

  private onBolt(bolt: Phaser.Physics.Arcade.Sprite) {
    if (!this.canBeHit()) return;
    bolt.destroy();
    this.loseShip();
  }

  private loseShip() {
    if (this.dead || this.over) return;
    this.dead = true;
    this.lives -= 1;
    this.beam.clear();
    this.beamHum(false);
    playSound(this, 'die');
    this.explode(this.player.x, this.player.y, COLORS.amber, 16);
    this.cameras.main.shake(180, 0.01);
    this.player.setVelocity(0).setVisible(false);
    this.player.body.enable = false;
    this.dropCargo(this.player.x, this.player.y);
    // Drones on screen blow up with you but aren't killed: they stay in the room's count.
    for (const e of this.enemies.getChildren() as Enemy[]) if (e.getData('kind') === 'hunter') this.explode(e.x, e.y, COLORS.danger, 6);
    this.clearHostiles();

    if (this.lives <= 0) {
      this.time.delayedCall(PLAYER.respawnDelayMs, () => {
        this.over = true;
        this.overAt = this.time.now;
        playSound(this, 'gameOver');
        if (this.controls.device === 'touch') {
          this.showBanner('GAME OVER', `SCORE ${pts(this.score)}`);
          this.addTapButtons();
        } else {
          this.showBanner('GAME OVER', `SCORE ${pts(this.score)}\nENTER / A  RETRY      ESC / B  TITLE`);
        }
      });
      return;
    }
    // Respawn back at the vault's starting point; the room you died in keeps your dropped cargo.
    this.time.delayedCall(PLAYER.respawnDelayMs, () => {
      this.enterRoom(this.vault.entrance);
      this.player.body.enable = true;
      this.player.setVisible(true);
      this.invulnerableUntil = this.time.now + PLAYER.invulnerableMs;
      this.dead = false;
    });
  }

  private addScore(points: number) {
    const before = Math.floor(this.score / SCORING.extraShipEvery);
    this.score += points;
    const earned = Math.floor(this.score / SCORING.extraShipEvery) - before;
    if (earned > 0) {
      this.lives += earned;
      playSound(this, 'extraShip');
      this.floatText(this.player.x, this.player.y - 14, 'EXTRA SHIP', TEXT.beam);
    }
  }

  // ---- Treasure, the wreck marker and banking ----

  private placeTreasure(loot: Loot) {
    const t = this.treasures.create(loot.x, loot.y, loot.kind) as Phaser.Physics.Arcade.Sprite;
    t.setDepth(4).setData('loot', loot);
    addTreasureGlow(this, t);
    (t.body as Phaser.Physics.Arcade.StaticBody).setCircle(5, 3, 3);
    const bob = this.tweens.add({ targets: t, y: loot.y - 1, duration: 600 + Math.random() * 300, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
    t.once(Phaser.GameObjects.Events.DESTROY, () => bob.remove());
    return t;
  }

  private collect(t: Phaser.Physics.Arcade.Sprite) {
    if (this.dead || !t.active) return;
    const loot = t.getData('loot') as Loot;
    this.room.loot.splice(this.room.loot.indexOf(loot), 1);
    this.cargo.push(loot.kind);
    this.floatText(t.x, t.y - 8, `+${TREASURE[loot.kind].name.toUpperCase()}`, TEXT.amber);
    playSound(this, 'pickup', { detune: Object.keys(TREASURE).indexOf(loot.kind) * 200 });
    t.destroy();
    // 5200 rules: picking up any treasure clears the wreck X.
    this.clearWreck();
    if (!this.room.loot.length) {
      this.showBanner('LOOT CLEAR', 'NOTHING LEFT TO GRAB IN THIS ROOM', 1600);
      this.time.delayedCall(180, () => playSound(this, 'chime'));
    }
  }

  private clearWreck() {
    this.vault.wreck = undefined;
  }

  /**
   * Cargo drops where the ship died (Atari 5200 rules). Every drop stays in its room until you pick it up
   * or the game ends; only the newest drop's room is marked with an X on the vault map, for one life.
   */
  private dropCargo(x: number, y: number) {
    this.clearWreck();
    if (!this.cargo.length) return;
    const cx = Phaser.Math.Clamp(x, INTERIOR.x0 + 14, INTERIOR.x1 - 14);
    const cy = Phaser.Math.Clamp(y, INTERIOR.y0 + 14, INTERIOR.y1 - 14);
    this.vault.wreck = this.room;
    // Rings of 8 around the X, so a big haul spreads out instead of stacking.
    this.cargo.forEach((kind, i) => {
      const ring = Math.floor(i / 8), slot = i % 8;
      const a = (slot / 8) * Math.PI * 2 + ring * 0.4;
      const r = this.cargo.length > 1 ? 11 + ring * 10 : 0;
      this.dropLoot(kind, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    });
    this.cargo = [];
  }

  /** Puts a treasure on this room's floor, kept inside the walls. */
  private dropLoot(kind: TreasureKind, x: number, y: number) {
    const loot: Loot = {
      kind, x: Phaser.Math.Clamp(x, INTERIOR.x0 + 6, INTERIOR.x1 - 6), y: Phaser.Math.Clamp(y, INTERIOR.y0 + 6, INTERIOR.y1 - 6),
    };
    this.room.loot.push(loot);
    this.placeTreasure(loot);
  }

  /** Landing on the extraction pad cashes in your cargo and ends the vault. */
  private bank() {
    if (this.dead || this.banking || this.over) return;
    this.banking = true;
    this.beam.clear();
    this.beamHum(false);
    this.clearHostiles();
    playSound(this, 'bank');

    const cargoValue = this.cargo.reduce((sum, k) => sum + TREASURE[k].value, 0);
    const visited = this.vault.rooms.filter((r) => r.visited).length;
    const explored = visited === GRID * GRID;
    this.addScore(cargoValue);
    if (explored) {
      this.addScore(SCORING.explorerBonus);
      this.lives += 1;
    }
    this.cargo = [];
    const detail = explored ? `EXPLORER BONUS +${pts(SCORING.explorerBonus)} AND A SHIP` : `ROOMS VISITED ${visited} OF ${GRID * GRID}`;
    this.showBanner(`VAULT ${this.vault.level} CLEAR`, `CARGO BANKED +${pts(cargoValue)}\n${detail}`, 2600);
    this.time.delayedCall(3000, () => {
      this.banking = false;
      this.startVault(this.vault.level + 1);
    });
  }

  // ---- Hostiles ----

  private addEnemy(kind: EnemyKind, x: number, y: number) {
    const e = this.enemies.create(x, y, kind) as Enemy;
    const big = kind === 'warden' || kind === 'brood';
    e.setCircle(big ? 7 : 6, big ? 1 : 2, big ? 1 : 2).setDepth(8).setCollideWorldBounds(true);
    e.setData({ kind, hp: ENEMY_HP[kind], armedAt: this.time.now + HUNTER.armMs });
    return e;
  }

  /** Places the room's sentries, mines, wardens and brood pods at their starting spots. */
  private buildFoes() {
    const now = this.time.now, grace = now + HUNTER.entryGraceMs;
    for (const foe of this.room.foes) {
      const e = this.addEnemy(foe.kind, foe.x, foe.y).setData('foe', foe);
      if (foe.kind === 'sentry' || foe.kind === 'brood') {
        e.setImmovable(true);
        (e.body as Phaser.Physics.Arcade.Body).moves = false;
      }
      if (foe.kind === 'sentry') e.setData('nextShotAt', grace + Math.random() * SENTRY.fireEveryMs);
      if (foe.kind === 'brood') e.setData('nextHatchAt', grace + BROOD.hatchEveryMs / 2);
      if (foe.kind === 'mine') e.setBounce(1).setData('wakeAt', grace);
    }
  }

  /** Removes everything hostile from the screen. A scavenger leaving with your loot hides it elsewhere. */
  private clearHostiles() {
    const scavenger = this.scavengers.getFirstAlive() as Enemy | null;
    if (scavenger) this.scavengerEscapes(scavenger);
    this.enemies.clear(true, true);
    this.bolts.clear(true, true);
  }

  private spawnHunter() {
    if (this.over || this.dead || this.banking || this.time.now < this.nextSpawnAt) return;
    const alive = (this.enemies.getChildren() as Enemy[]).filter((e) => e.getData('kind') === 'hunter' && !e.getData('brood')).length;
    if (alive >= Math.min(HUNTER.maxAlive, this.room.hunters)) return;
    const options = doorTiles(this.room).filter((p) => Phaser.Math.Distance.Between(p.x, p.y, this.player.x, this.player.y) > 64);
    if (!options.length) return;
    const at = Phaser.Utils.Array.GetRandom(options);
    const h = this.addEnemy('hunter', at.x, at.y).setAlpha(0);
    this.tweens.add({ targets: h, alpha: 1, duration: HUNTER.armMs });
    this.nextSpawnAt = this.time.now + HUNTER.spawnEveryMs;
  }

  private updateEnemies(time: number) {
    const hunterSpeed = HUNTER.speed + (this.vault.level - 1) * HUNTER.speedPerLevel;
    for (const e of [...this.enemies.getChildren()] as Enemy[]) {
      if (this.dead) {
        e.setVelocity(0);
        continue;
      }
      switch (e.getData('kind') as EnemyKind) {
        case 'hunter':
          this.physics.moveToObject(e, this.player, hunterSpeed);
          break;
        case 'mine': {
          if (time < e.getData('wakeAt')) break;
          const v = (e.body as Phaser.Physics.Arcade.Body).velocity;
          // Straight diagonal lines; bounces keep the speed, bumps into other hostiles don't sap it.
          if (v.lengthSq() < 1) v.setToPolar(Phaser.Math.DegToRad(45 + 90 * Phaser.Math.Between(0, 3)), MINE.speed);
          else v.setLength(MINE.speed);
          break;
        }
        case 'warden':
          this.moveWarden(e);
          break;
        case 'sentry': {
          const shotAt = e.getData('nextShotAt') as number;
          // Blinks (and beeps) just before it fires, so you can get out of the line.
          const warning = time > shotAt - SENTRY.telegraphMs;
          e.setAlpha(warning && Math.floor(time / 60) % 2 ? 0.4 : 1);
          if (warning && !e.getData('warned')) {
            e.setData('warned', true);
            playSound(this, 'warn');
          }
          if (time >= shotAt) {
            e.setData('warned', false);
            this.fireBolt(e);
            e.setData('nextShotAt', time + SENTRY.fireEveryMs * Phaser.Math.FloatBetween(0.8, 1.2));
          }
          break;
        }
        case 'brood':
          if (time >= e.getData('nextHatchAt')) {
            e.setData('nextHatchAt', time + BROOD.hatchEveryMs);
            if (this.broodDrones() < BROOD.maxDrones) this.hatch(e);
          }
          break;
      }
    }
  }

  /** Parks between you and the nearest treasure in the room; with no treasure left, it comes for you. */
  private moveWarden(e: Enemy) {
    const loot = this.room.loot.reduce<Loot | undefined>(
      (best, l) => (!best || Phaser.Math.Distance.Between(e.x, e.y, l.x, l.y) < Phaser.Math.Distance.Between(e.x, e.y, best.x, best.y) ? l : best),
      undefined,
    );
    if (!loot) {
      this.physics.moveToObject(e, this.player, WARDEN.speed);
      return;
    }
    const a = Phaser.Math.Angle.Between(loot.x, loot.y, this.player.x, this.player.y);
    const gx = loot.x + Math.cos(a) * WARDEN.guardDistance, gy = loot.y + Math.sin(a) * WARDEN.guardDistance;
    if (Phaser.Math.Distance.Between(e.x, e.y, gx, gy) < 2) e.setVelocity(0);
    else this.physics.moveTo(e, gx, gy, WARDEN.speed);
  }

  private fireBolt(sentry: Enemy) {
    const bolt = this.bolts.create(sentry.x, sentry.y, BOLT) as Phaser.Physics.Arcade.Sprite;
    bolt.setDepth(9).setCircle(2, 0.5, 0.5);
    const a = Phaser.Math.Angle.Between(sentry.x, sentry.y, this.player.x, this.player.y);
    this.physics.velocityFromRotation(a, SENTRY.boltSpeed, (bolt.body as Phaser.Physics.Arcade.Body).velocity);
    playSound(this, 'bolt');
  }

  /** Bolts stop at the walls. */
  private updateBolts() {
    for (const b of [...this.bolts.getChildren()] as Phaser.Physics.Arcade.Sprite[]) {
      if (this.dead) b.setVelocity(0);
      if (!insideInterior(b.x, b.y)) b.destroy();
    }
  }

  private broodDrones() {
    return (this.enemies.getChildren() as Enemy[]).filter((e) => e.getData('brood')).length;
  }

  /** Brood drones hunt like any drone but don't count toward the room: only the pod does. */
  private hatch(brood: Enemy) {
    const a = Math.random() * Math.PI * 2;
    const d = this.addEnemy('hunter', brood.x + Math.cos(a) * 12, brood.y + Math.sin(a) * 12).setData('brood', true).setAlpha(0);
    this.tweens.add({ targets: d, alpha: 1, duration: HUNTER.armMs });
    this.explode(brood.x, brood.y, COLORS.danger, 6);
    playSound(this, 'hatch');
  }

  private hurt(e: Enemy, amount: number) {
    if (e.getData('kind') === 'scavenger') {
      this.shoo(e, amount);
      return;
    }
    const hp = (e.getData('hp') as number) - amount;
    e.setData('hp', hp);
    if (hp <= 0) this.kill(e);
  }

  private kill(e: Enemy) {
    const kind = e.getData('kind') as EnemyKind;
    const foe = e.getData('foe') as Foe | undefined;
    // Read everything before destroy(): Phaser wipes the data, and getData() afterwards quietly returns undefined.
    const fromBrood = e.getData('brood') === true;
    this.explode(e.x, e.y, COLORS.danger, kind === 'brood' ? 24 : 10);
    playSound(this, kind === 'brood' || kind === 'warden' ? 'boomBig' : 'boom');
    this.floatText(e.x, e.y - 8, `${ENEMY_POINTS[kind]}`, TEXT.ink);
    e.destroy();
    if (foe) this.room.foes.splice(this.room.foes.indexOf(foe), 1);
    else if (!fromBrood) this.room.hunters -= 1;
    this.addScore(ENEMY_POINTS[kind]);
    if (!hostileCount(this.room) && !fromBrood) {
      this.floatText(ROOM_W / 2, HUD_H + 30, 'ROOM SECURE', TEXT.beam);
      this.time.delayedCall(180, () => playSound(this, 'chime'));
    }
  }

  // ---- Scavenger ----

  private updateScavenger(time: number) {
    if (!this.scavengerRolled && this.cargo.length) {
      this.scavengerRolled = true;
      if (Math.random() < SCAVENGER.chance) this.scavengerDue = time + Phaser.Math.Between(...SCAVENGER.delayMs);
    }
    if (this.scavengerDue !== undefined && time >= this.scavengerDue && !this.dead) {
      this.scavengerDue = undefined;
      this.spawnScavenger();
    }
    const s = this.scavengers.getFirstAlive() as Enemy | null;
    if (!s) return;
    if (this.dead) {
      s.setVelocity(0);
      return;
    }
    if (s.getData('fleeing')) {
      const to = s.getData('fleeTo') as { x: number; y: number };
      this.physics.moveTo(s, to.x, to.y, SCAVENGER.fleeSpeed);
      if (s.x < -8 || s.x > ROOM_W + 8 || s.y < HUD_H - 8 || s.y > HUD_H + ROOM_H + 8) this.scavengerEscapes(s);
    } else {
      this.physics.moveToObject(s, this.player, SCAVENGER.speed);
    }
  }

  private spawnScavenger() {
    if (this.scavengers.getFirstAlive()) return;
    const doors = doorTiles(this.room);
    const at = doors.reduce((far, p) =>
      Phaser.Math.Distance.Between(p.x, p.y, this.player.x, this.player.y) > Phaser.Math.Distance.Between(far.x, far.y, this.player.x, this.player.y) ? p : far);
    const s = this.scavengers.create(at.x, at.y, 'scavenger') as Enemy;
    s.setCircle(6, 2, 2).setDepth(8).setAlpha(0.7);
    s.setData({ kind: 'scavenger', shoo: SCAVENGER.shooHp, armedAt: this.time.now + HUNTER.armMs, fleeing: false });
    this.floatText(at.x, Phaser.Math.Clamp(at.y, HUD_H + 14, HUD_H + ROOM_H - 14), 'SCAVENGER!', TEXT.danger);
    playSound(this, 'scavenger');
  }

  /** Grabs your most valuable piece of cargo and runs for it. */
  private onScavengerTouch(s: Enemy) {
    if (this.dead || this.over || this.banking || s.getData('fleeing') || this.time.now < (s.getData('armedAt') as number)) return;
    if (this.cargo.length) {
      const best = this.cargo.reduce((bi, k, i, all) => (TREASURE[k].value > TREASURE[all[bi]].value ? i : bi), 0);
      const [kind] = this.cargo.splice(best, 1);
      s.setData('stolen', kind).setTint(COLORS.loot);
      playSound(this, 'steal');
      this.floatText(this.player.x, this.player.y - 12, `-${TREASURE[kind].name.toUpperCase()}`, TEXT.danger);
    }
    this.flee(s);
  }

  /** Off through the nearest wall: scavengers don't need doors. */
  private flee(s: Enemy) {
    const edges = [
      { d: s.y - HUD_H, x: s.x, y: HUD_H - 32 },
      { d: HUD_H + ROOM_H - s.y, x: s.x, y: HUD_H + ROOM_H + 32 },
      { d: s.x, x: -32, y: s.y },
      { d: ROOM_W - s.x, x: ROOM_W + 32, y: s.y },
    ];
    const to = edges.reduce((a, b) => (b.d < a.d ? b : a));
    s.setData({ fleeing: true, fleeTo: { x: to.x, y: to.y } });
  }

  /** Enough beam makes it drop what it stole and run. It can't be destroyed. */
  private shoo(s: Enemy, amount: number) {
    if (s.getData('shooed')) return;
    const left = (s.getData('shoo') as number) - amount;
    s.setData('shoo', left);
    if (left > 0) return;
    s.setData('shooed', true);
    playSound(this, 'shoo');
    this.addScore(SCAVENGER.points);
    this.floatText(s.x, s.y - 8, `${SCAVENGER.points}`, TEXT.ink);
    const stolen = s.getData('stolen') as TreasureKind | undefined;
    if (stolen) {
      this.dropLoot(stolen, s.x, s.y);
      s.setData('stolen', undefined).clearTint();
    }
    this.flee(s);
  }

  private scavengerEscapes(s: Enemy) {
    const stolen = s.getData('stolen') as TreasureKind | undefined;
    s.destroy();
    if (!stolen) return;
    const rooms = this.vault.rooms.filter((r) => r !== this.room && r !== this.vault.exit);
    const hideout = Phaser.Utils.Array.GetRandom(rooms);
    hideout.loot.push({ kind: stolen, ...tileCenter(Phaser.Math.Between(3, COLS - 4), Phaser.Math.Between(3, ROWS - 4)) });
    playSound(this, 'steal', { detune: -500 });
    this.showBanner('LOOT STOLEN', `THE SCAVENGER HID YOUR ${TREASURE[stolen].name.toUpperCase()}\nSOMEWHERE ELSE IN THE VAULT`, 2200);
  }

  // ---- Beam ----

  /** The beam's hum loops while you fire, and rises in pitch while it's hitting something. */
  private beamHum(on: boolean, hitting = false) {
    const hum = this.beamSound;
    if (!hum) return;
    if (on && !hum.isPlaying) hum.play();
    else if (!on && hum.isPlaying) hum.stop();
    if (on) hum.setDetune(hitting ? 300 : 0);
  }

  private updateBeam(firing: boolean, rawAim: number, dt: number) {
    this.beam.clear();
    this.beamHum(firing && !this.dead);
    if (this.dead) return;
    const step = Math.PI / 4;
    const aim = this.snap8 ? Math.round(rawAim / step) * step : rawAim;
    const dx = Math.cos(aim), dy = Math.sin(aim);
    // The hull never rotates: the beam leaves from the edge of a 14px box, so diagonals exit at a corner.
    const hull = 7 / Math.max(Math.abs(dx), Math.abs(dy));
    const sx = this.player.x + dx * hull, sy = this.player.y + dy * hull;

    if (firing) {
      let length = rayToWall(sx, sy, dx, dy);
      let target: Enemy | undefined;
      const targets = [
        ...(this.enemies.getChildren() as Enemy[]),
        ...(this.scavengers.getChildren() as Enemy[]).filter((s) => !s.getData('shooed')),
      ];
      for (const e of targets) {
        const kind = e.getData('kind');
        const radius = kind === 'warden' ? WARDEN.hitRadius : kind === 'brood' ? BROOD.hitRadius : BEAM.hitRadius;
        const t = rayCircle(sx, sy, dx, dy, e.x, e.y, radius);
        if (t < length) {
          length = t;
          target = e;
        }
      }
      const ex = sx + dx * length, ey = sy + dy * length;
      this.beam.lineStyle(4, COLORS.beam, 0.28).lineBetween(sx, sy, ex, ey);
      this.beam.lineStyle(1, COLORS.beamCore, 1).lineBetween(sx, sy, ex, ey);
      this.beam.fillStyle(target ? COLORS.beamCore : COLORS.beam).fillRect(Math.round(ex) - 2, Math.round(ey) - 2, 4, 4);
      if (target) this.hurt(target, BEAM.damagePerSecond * dt);
      this.beamHum(true, Boolean(target));
    }
    this.beam.fillStyle(firing ? COLORS.beamCore : COLORS.beam).fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
  }

  // ---- Effects ----

  private explode(x: number, y: number, color: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 8 + Math.random() * 14;
      const bit = this.add.rectangle(x, y, 2, 2, color).setDepth(20);
      this.roomFx.add(bit);
      this.tweens.add({
        targets: bit, x: x + Math.cos(a) * dist, y: y + Math.sin(a) * dist, alpha: 0,
        duration: 300 + Math.random() * 250, ease: 'Quad.out', onComplete: () => bit.destroy(),
      });
    }
  }

  private floatText(x: number, y: number, text: string, color: string) {
    const t = this.add.text(x, y, text, { fontFamily: FONT, fontSize: '8px', color }).setOrigin(0.5).setDepth(140);
    this.roomFx.add(t);
    this.tweens.add({ targets: t, y: y - 10, alpha: 0, duration: 900, onComplete: () => t.destroy() });
  }

  /** Game over on a phone: RETRY and TITLE as words to tap. */
  private addTapButtons() {
    const y = HUD_H + ROOM_H / 2 - 8;
    const button = (x: number, label: string, action: () => void) => {
      const t = this.add.text(x, y, label, { fontFamily: FONT, fontSize: '16px', color: TEXT.amber }).setOrigin(0.5).setDepth(150);
      t.setInteractive(new Phaser.Geom.Rectangle(-16, -12, t.width + 32, t.height + 24), Phaser.Geom.Rectangle.Contains);
      t.on('pointerdown', () => {
        if (this.time.now - this.overAt > 800) action();
      });
    };
    button(ROOM_W / 2 - 52, 'RETRY', () => this.scene.restart());
    button(ROOM_W / 2 + 52, 'TITLE', () => this.toTitle());
  }

  private hideBanner() {
    this.bannerFade?.remove();
    this.bannerFade = undefined;
    this.banner.setAlpha(0);
    this.subBanner.setAlpha(0);
  }

  private showBanner(title: string, sub: string, ms?: number) {
    this.bannerFade?.remove();
    this.bannerFade = undefined;
    this.banner.setText(title).setAlpha(1);
    this.subBanner.setText(sub).setAlpha(1);
    if (ms) this.bannerFade = this.tweens.add({ targets: [this.banner, this.subBanner], alpha: 0, delay: ms, duration: 400 });
  }
}
