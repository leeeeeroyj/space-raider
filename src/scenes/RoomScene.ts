import Phaser from 'phaser';
import {
  AIM_MODE_SELECTABLE, BEAM, COLORS, COLS, FONT, HUD_H, HUD_STATE, HUNTER, INTERIOR, PLAYER, RENDER_SCALE, ROOM_H, ROOM_W,
  ROWS, SCORING, SNAP8, TEXT, TILE, TREASURE, tileCenter, type TreasureKind,
} from '../config';
import { Controls } from '../controls';
import { addGlow, addTreasureGlow, startSparkles } from '../fx';
import { fitCamera } from '../view';
import { GRID, OPPOSITE, SIDES, generateVault, mapCell, neighbor, roomIndex, type Loot, type Room, type Side, type Vault } from '../vault';
import type { HudState } from './HudScene';

const CENTER = tileCenter(10, 6);
const pts = (n: number) => n.toLocaleString('en-US');

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

export class RoomScene extends Phaser.Scene {
  private controls!: Controls;
  private player!: Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
  private walls!: Phaser.Physics.Arcade.StaticGroup;
  private hunters!: Phaser.Physics.Arcade.Group;
  private treasures!: Phaser.Physics.Arcade.StaticGroup;
  private pads!: Phaser.Physics.Arcade.StaticGroup;
  private doorGlow: Phaser.GameObjects.Graphics | undefined;
  private wreckMark: Phaser.GameObjects.Image | undefined;
  private beam!: Phaser.GameObjects.Graphics;
  private crosshair!: Phaser.GameObjects.Graphics;
  private banner!: Phaser.GameObjects.Text;
  private subBanner!: Phaser.GameObjects.Text;
  private bannerFade: Phaser.Tweens.Tween | undefined;

  private vault!: Vault;
  private room!: Room;
  /** Where you respawn after losing a ship: the doorway you entered this room by. */
  private entry = CENTER;
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

  constructor() {
    super('room');
  }

  create() {
    // Scene.restart() reuses this instance, so all run state is reset here.
    Object.assign(this, {
      score: 0, lives: PLAYER.lives, cargo: [], dead: false, over: false, banking: false, invulnerableUntil: 0,
      wreckMark: undefined, doorGlow: undefined, bannerFade: undefined, runSeed: `${Date.now()}-${Math.random()}`,
    });
    this.snap8 = AIM_MODE_SELECTABLE && this.registry.get(SNAP8) === true;
    fitCamera(this, RENDER_SCALE);
    this.input.setDefaultCursor('none');
    this.scene.launch('hud');

    this.physics.world.setBounds(0, HUD_H, ROOM_W, ROOM_H);
    this.drawFloor();
    this.walls = this.physics.add.staticGroup();
    this.treasures = this.physics.add.staticGroup();
    this.pads = this.physics.add.staticGroup();
    this.hunters = this.physics.add.group();

    // No world-bounds collision for the ship: walls stop it, doorways let it through to the next room.
    this.player = this.physics.add.image(CENTER.x, CENTER.y, 'player').setDepth(10);
    this.player.setCircle(PLAYER.radius, 8 - PLAYER.radius, 8 - PLAYER.radius);

    this.physics.add.collider(this.player, this.walls);
    this.physics.add.collider(this.hunters, this.walls);
    this.physics.add.collider(this.hunters, this.hunters);
    this.physics.add.overlap(this.player, this.hunters, (_p, h) => this.onHunterTouch(h as Phaser.Physics.Arcade.Sprite));
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

    if (this.over) {
      if (time - this.overAt > 800) {
        if (input.confirm) this.scene.restart();
        else if (input.back) this.toTitle();
      }
      this.beam.clear();
    } else if (this.banking) {
      this.player.setVelocity(0);
      this.beam.clear();
    } else {
      this.updatePlayer(input.move, time);
      this.updateHunters();
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
      hostiles: this.room.hostilesLeft,
      map: {
        cells: this.vault.rooms.map(mapCell),
        current: roomIndex(this.room),
        exit: roomIndex(this.vault.exit),
        wreck: this.vault.wreck ? roomIndex(this.vault.wreck.room) : -1,
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

  /** Swaps the room's contents for `room`. Drones still alive stay counted in the room you left. */
  private enterRoom(room: Room, from?: Side) {
    this.hunters.clear(true, true);
    this.treasures.clear(true, true);
    this.walls.clear(true, true);
    this.pads.clear(true, true);
    this.doorGlow?.destroy();
    this.wreckMark?.destroy();
    this.wreckMark = undefined;

    this.room = room;
    room.visited = true;
    this.buildWalls(room);
    for (const loot of room.loot) this.placeTreasure(loot);
    if (this.vault.wreck?.room === room) this.wreckMark = this.add.image(this.vault.wreck.x, this.vault.wreck.y, 'xmark').setDepth(3);
    if (room === this.vault.exit) {
      const pad = this.pads.create(CENTER.x, CENTER.y, 'exit') as Phaser.Physics.Arcade.Sprite;
      addGlow(this, pad.setDepth(3), COLORS.beam);
      (pad.body as Phaser.Physics.Arcade.StaticBody).setCircle(4, 4, 4);
      this.showBanner('EXTRACTION', 'FLY ONTO THE PAD TO BANK YOUR CARGO\nAND LEAVE THE VAULT', 2200);
    }

    this.entry = from ? entryPoint(room, from) : CENTER;
    this.player.body.reset(this.entry.x, this.entry.y);
    this.nextSpawnAt = this.time.now + HUNTER.entryGraceMs;
    this.cameras.main.fadeIn(160);
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

  private onHunterTouch(hunter: Phaser.Physics.Arcade.Sprite) {
    if (this.dead || this.over || this.banking || this.time.now < this.invulnerableUntil) return;
    if (this.time.now < (hunter.getData('armedAt') as number)) return;
    this.loseShip();
  }

  private loseShip() {
    if (this.dead || this.over) return;
    this.dead = true;
    this.lives -= 1;
    this.beam.clear();
    this.explode(this.player.x, this.player.y, COLORS.amber, 16);
    this.cameras.main.shake(180, 0.01);
    this.player.setVelocity(0).setVisible(false);
    this.player.body.enable = false;
    this.dropCargo(this.player.x, this.player.y);
    // Drones on screen blow up with you but aren't killed: they stay in the room's count.
    for (const h of [...this.hunters.getChildren()] as Phaser.Physics.Arcade.Sprite[]) {
      this.explode(h.x, h.y, COLORS.danger, 6);
      h.destroy();
    }

    if (this.lives <= 0) {
      this.time.delayedCall(PLAYER.respawnDelayMs, () => {
        this.over = true;
        this.overAt = this.time.now;
        this.showBanner('GAME OVER', `SCORE ${pts(this.score)}\nENTER / A  RETRY      ESC / B  TITLE`);
      });
      return;
    }
    this.time.delayedCall(PLAYER.respawnDelayMs, () => {
      this.player.body.reset(this.entry.x, this.entry.y);
      this.player.body.enable = true;
      this.player.setVisible(true);
      this.invulnerableUntil = this.time.now + PLAYER.invulnerableMs;
      this.nextSpawnAt = this.time.now + HUNTER.entryGraceMs;
      this.dead = false;
    });
  }

  private addScore(points: number) {
    const before = Math.floor(this.score / SCORING.extraShipEvery);
    this.score += points;
    const earned = Math.floor(this.score / SCORING.extraShipEvery) - before;
    if (earned > 0) {
      this.lives += earned;
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
    t.destroy();
    // 5200 rules: picking up any treasure clears the wreck X.
    this.clearWreck();
    if (!this.room.loot.length) this.showBanner('LOOT CLEAR', 'NOTHING LEFT TO GRAB IN THIS ROOM', 1600);
  }

  private clearWreck() {
    this.wreckMark?.destroy();
    this.wreckMark = undefined;
    this.vault.wreck = undefined;
  }

  /**
   * Cargo drops where the ship died (Atari 5200 rules). Every drop stays in its room until you pick it up
   * or the game ends; only the newest drop is marked with an X, and that X lasts for one life.
   */
  private dropCargo(x: number, y: number) {
    this.clearWreck();
    if (!this.cargo.length) return;
    const cx = Phaser.Math.Clamp(x, INTERIOR.x0 + 14, INTERIOR.x1 - 14);
    const cy = Phaser.Math.Clamp(y, INTERIOR.y0 + 14, INTERIOR.y1 - 14);
    this.vault.wreck = { room: this.room, x: cx, y: cy };
    this.wreckMark = this.add.image(cx, cy, 'xmark').setDepth(3);
    // Rings of 8 around the X, so a big haul spreads out instead of stacking.
    this.cargo.forEach((kind, i) => {
      const ring = Math.floor(i / 8), slot = i % 8;
      const a = (slot / 8) * Math.PI * 2 + ring * 0.4;
      const r = this.cargo.length > 1 ? 11 + ring * 10 : 0;
      const loot: Loot = {
        kind,
        x: Phaser.Math.Clamp(cx + Math.cos(a) * r, INTERIOR.x0 + 6, INTERIOR.x1 - 6),
        y: Phaser.Math.Clamp(cy + Math.sin(a) * r, INTERIOR.y0 + 6, INTERIOR.y1 - 6),
      };
      this.room.loot.push(loot);
      this.placeTreasure(loot);
    });
    this.cargo = [];
  }

  /** Landing on the extraction pad cashes in your cargo and ends the vault. */
  private bank() {
    if (this.dead || this.banking || this.over) return;
    this.banking = true;
    this.beam.clear();
    for (const h of [...this.hunters.getChildren()] as Phaser.Physics.Arcade.Sprite[]) h.destroy();

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

  // ---- Hunters ----

  private spawnHunter() {
    if (this.over || this.dead || this.banking || this.time.now < this.nextSpawnAt) return;
    const alive = this.hunters.countActive();
    if (alive >= Math.min(HUNTER.maxAlive, this.room.hostilesLeft)) return;
    const doors = doorTiles(this.room);
    const options = doors.filter((p) => Phaser.Math.Distance.Between(p.x, p.y, this.player.x, this.player.y) > 64);
    if (!options.length) return;
    const at = Phaser.Utils.Array.GetRandom(options);
    const h = this.hunters.create(at.x, at.y, 'hunter') as Phaser.Physics.Arcade.Sprite;
    h.setCircle(6, 2, 2).setDepth(8).setAlpha(0).setCollideWorldBounds(true);
    h.setData('hp', HUNTER.hp).setData('armedAt', this.time.now + HUNTER.armMs);
    this.tweens.add({ targets: h, alpha: 1, duration: HUNTER.armMs });
    this.nextSpawnAt = this.time.now + HUNTER.spawnEveryMs;
  }

  private updateHunters() {
    const speed = HUNTER.speed + (this.vault.level - 1) * HUNTER.speedPerLevel;
    for (const h of this.hunters.getChildren() as Phaser.Physics.Arcade.Sprite[]) {
      if (this.dead) h.setVelocity(0);
      else this.physics.moveToObject(h, this.player, speed);
    }
  }

  private killHunter(h: Phaser.Physics.Arcade.Sprite) {
    this.explode(h.x, h.y, COLORS.danger, 10);
    this.floatText(h.x, h.y - 8, `${HUNTER.points}`, TEXT.ink);
    h.destroy();
    this.room.hostilesLeft -= 1;
    this.addScore(HUNTER.points);
    if (this.room.hostilesLeft === 0) this.floatText(ROOM_W / 2, HUD_H + 30, 'ROOM SECURE', TEXT.beam);
  }

  // ---- Beam ----

  private updateBeam(firing: boolean, rawAim: number, dt: number) {
    this.beam.clear();
    if (this.dead) return;
    const step = Math.PI / 4;
    const aim = this.snap8 ? Math.round(rawAim / step) * step : rawAim;
    const dx = Math.cos(aim), dy = Math.sin(aim);
    // The hull never rotates: the beam leaves from the edge of a 14px box, so diagonals exit at a corner.
    const hull = 7 / Math.max(Math.abs(dx), Math.abs(dy));
    const sx = this.player.x + dx * hull, sy = this.player.y + dy * hull;

    if (firing) {
      let length = rayToWall(sx, sy, dx, dy);
      let target: Phaser.Physics.Arcade.Sprite | undefined;
      for (const h of this.hunters.getChildren() as Phaser.Physics.Arcade.Sprite[]) {
        const t = rayCircle(sx, sy, dx, dy, h.x, h.y, BEAM.hitRadius);
        if (t < length) { length = t; target = h; }
      }
      const ex = sx + dx * length, ey = sy + dy * length;
      this.beam.lineStyle(4, COLORS.beam, 0.28).lineBetween(sx, sy, ex, ey);
      this.beam.lineStyle(1, COLORS.beamCore, 1).lineBetween(sx, sy, ex, ey);
      this.beam.fillStyle(target ? COLORS.beamCore : COLORS.beam).fillRect(Math.round(ex) - 2, Math.round(ey) - 2, 4, 4);
      if (target) {
        const hp = (target.getData('hp') as number) - BEAM.damagePerSecond * dt;
        target.setData('hp', hp);
        if (hp <= 0) this.killHunter(target);
      }
    }
    this.beam.fillStyle(firing ? COLORS.beamCore : COLORS.beam).fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
  }

  // ---- Effects ----

  private explode(x: number, y: number, color: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 8 + Math.random() * 14;
      const bit = this.add.rectangle(x, y, 2, 2, color).setDepth(20);
      this.tweens.add({
        targets: bit, x: x + Math.cos(a) * dist, y: y + Math.sin(a) * dist, alpha: 0,
        duration: 300 + Math.random() * 250, ease: 'Quad.out', onComplete: () => bit.destroy(),
      });
    }
  }

  private floatText(x: number, y: number, text: string, color: string) {
    const t = this.add.text(x, y, text, { fontFamily: FONT, fontSize: '8px', color }).setOrigin(0.5).setDepth(140);
    this.tweens.add({ targets: t, y: y - 10, alpha: 0, duration: 900, onComplete: () => t.destroy() });
  }

  private showBanner(title: string, sub: string, ms?: number) {
    this.bannerFade?.remove();
    this.bannerFade = undefined;
    this.banner.setText(title).setAlpha(1);
    this.subBanner.setText(sub).setAlpha(1);
    if (ms) this.bannerFade = this.tweens.add({ targets: [this.banner, this.subBanner], alpha: 0, delay: ms, duration: 400 });
  }
}
